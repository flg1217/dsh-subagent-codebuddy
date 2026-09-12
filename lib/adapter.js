/**
 * CodeBuddy 模型适配器:provider 路由 `codebuddy`,走 ACP(Agent Client Protocol)。
 *
 * 两条路径(路线 C1 起):
 *
 * 1. **回合泵**(`src/pump.ts`):会话绑定且调用方(agent-loop)已打开 step
 *    的对话轮。一个 CodeBuddy 回合 = 一个 ACP 进程,按**模型调用**切段,
 *    每个 dsh step 消费一段;工具调用注册 per-agent 的回放工具、由 loop
 *    原生写 `assistant/message` / `tool/call` / `tool/result`——适配器自己
 *    零会话写入。这样「一次模型调用 = 一个 step」与 dsh 语义一致:文本/工具
 *    顺序、每步用量、分页、客户端末条胜出渲染全部自然成立。
 * 2. **一次性旁路会话**(压缩/会话标题等 purpose 调用、无会话调用):
 *    纯 chunk 流,零写入。
 *
 * ACP 层的关键机制(两条路径共用):
 * - **会话生命周期官方化**:`session/new` / `session/load`(历史回放)复用
 *   长线会话;`session/prompt` 流式 `session/update`(含 thinking 流);
 * - **协议级取消**:`session/cancel` 对生成流与正在执行的工具都是即时抢占
 *   (实测),abort 信号驱动周期性重发(思考早期单次通知可能被吞);
 * - **静默失败自动重试**:CodeBuddy 服务端偶发静默失败(实测高频)——
 *   end_turn 但零思考零文本零工具。泵在首段无产出时重启一次(恢复同一
 *   会话续跑);已有产出的回合以显式错误收尾;
 * - **假死防御分层**:进展性 update(消息/思考/工具)重置动态空闲阈值;
 *   CLI 心跳(session_info/usage/config)与 stderr 不参与续命;静默超
 *   阈值先发 cancel、5s 仍无响应才 kill——进程退出码与 stderr 全程留证。
 * @module subagent-codebuddy/adapter
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReasoningEffortId, LlmAdapter } from '@deepseek-ai/dsh-llm';
import { ConversationStore } from './conversations.js';
import { conversationFilePath, messagesToRecords, uuidv7, writeConversationFile } from './native-session.js';
import { buildPrompt, lastUserPrompt, resumeReplayPrompt } from './serialize.js';
import { TodoListState } from './todo-bridge.js';
import { AcpConnection, DEFAULT_ACP_RUN_TIMEOUTS, isProgressUpdate, usageOfUpdate } from './acp.js';
import { failureOfError, formatFailureLine, isFailureOutcome, parseCodebuddyFailure } from './failure.js';
import { TurnPump } from './pump.js';
import { syncCliIntegrations } from './cli-integrations.js';
import { listCodebuddyModelIdsAsync } from './models.js';
/** purpose 调用的隔离工作目录(懒建;一次性旁路会话不落进用户项目)。 */
function purposeWorkDir() {
    const dir = join(tmpdir(), 'codebuddy-duty');
    mkdirSync(dir, { recursive: true });
    return dir;
}
/** 可重试的委托失败:恢复同一会话续跑(ACP session/load)即可,不重复已完成部分。 */
class RetryableError extends Error {
}
/** 取第一个非空字符串。 */
function firstNonEmpty(...values) {
    for (const value of values) {
        if (value !== undefined && value.length > 0)
            return value;
    }
    return undefined;
}
/**
 * 按失败分类收尾:可重试分类(网络/模型服务等瞬时故障)抛 RetryableError,
 * 外层恢复会话续跑;配额/认证等重试无意义的分类直接显式中止——让对话里
 * 显示真实中断原因,而不是笼统的"静默失败"。
 */
function throwFailure(prefix, failure, suffix) {
    if (failure === undefined)
        throw new Error(`${prefix}未知错误`);
    const message = `${prefix}${formatFailureLine(failure, suffix)}`;
    if (failure.retryable)
        throw new RetryableError(message);
    throw new Error(message);
}
/**
 * 插话链路诊断日志(临时):`~/.dsh/codebuddy/steer-debug.log`。
 * 静默失败会让"点了插话没反应"无从定位,这里把每次轮询的判定写盘。
 */
export function steerDebug(line) {
    try {
        mkdirSync(join(homedir(), '.dsh', 'codebuddy'), { recursive: true });
        appendFileSync(join(homedir(), '.dsh', 'codebuddy', 'steer-debug.log'), `${new Date().toISOString()} ${line}\n`);
    }
    catch { /* 诊断不影响主流程 */ }
}
/** listModels 成功缓存时长。 */
const SUCCESS_TTL_MS = 10 * 60_000;
/** listModels 失败缓存时长(CLI 缺失/挂起时避免每次目录拉取都 spawn)。 */
const FAILURE_TTL_MS = 60_000;
/**
 * CodeBuddy CLI `--effort` 支持的推理强度档位(与 TUI 的 Effort 选择器一致,
 * 顺序即选择器展示顺序:从 Faster 到 Smarter)。
 * 暴露给 dsh 的模型元数据,选中后每次调用以 `--effort <level>` 传给 CLI。
 */
const CODEBUDDY_EFFORTS = [
    { level: 'low', name: 'Low', description: '低推理强度(--effort low)' },
    { level: 'medium', name: 'Medium', description: '中推理强度(--effort medium)' },
    { level: 'high', name: 'High', description: '高推理强度(--effort high)' },
    { level: 'xhigh', name: 'XHigh', description: '极高推理强度(--effort xhigh)' },
    { level: 'max', name: 'Max', description: '最大推理强度(--effort max)' },
    { level: 'ultracode', name: 'Ultracode', description: 'XHigh + 工作流(--effort ultracode)' },
];
/**
 * 会话中最后一个已打开(尚无配对 step/end)的 turn/step。
 *
 * 它是「调用方是 agent-loop 的对话轮」的判据:只有这种调用才走回合泵
 * (路线 C1,一个 CodeBuddy 回合 = 多个原生 step);压缩/标题这类旁路调用
 * 没有打开 step,走一次性会话。
 * @param events - 会话自身的已提交事件(ownEvents)。
 * @returns 打开的 turn/step,没有则为 undefined。
 */
export function findOpenStep(events) {
    let open;
    for (const event of events) {
        if (event.type === 'step/start') {
            open = { turn: event.data.turn, step: event.data.step };
        }
        else if (event.type === 'step/end' && open !== undefined
            && event.data.turn === open.turn && event.data.step === open.step) {
            open = undefined;
        }
    }
    return open;
}
/**
 * CodeBuddy 模型适配器。stream() 每次调用:
 * spawn `codebuddy --acp` → initialize → session/new(或 session/load 复用)
 * → session/prompt → 消费 session/update(思考/文本/工具)→ finish 收尾。
 * 每次调用一个 ACP 进程,用完退出;会话连续性由 CodeBuddy 会话存储 +
 * session/load 保证(实测回放完整);续接映射持久化,服务重启后自动恢复;
 * 静默失败自动恢复会话续跑。
 */
export class CodebuddyLlmAdapter extends LlmAdapter {
    ctx;
    options;
    /**
     * dsh 会话 → CodeBuddy ACP 会话的续接映射(持久化,跨服务重启恢复)。
     *
     * 首次调用 `session/new` 建立并记录;之后同一会话的每次 stream 都
     * `session/load` 载入同一会话(官方实现会先回放历史事件,回放不落地)。
     */
    conversations;
    /** listModels 缓存与并发合并(目录拉取热路径)。 */
    modelCache;
    modelFetch;
    /** 中继回退:同一会话最多保留的转发 id 数(防无界增长)。 */
    static FORWARDED_CAP = 256;
    /** dsh 会话 → todo 列表状态(CodeBuddy 任务工具折算整表快照,跨轮复用)。 */
    todoStates = new Map();
    /** dsh 会话 → 已转发的插入消息 id(续聊补发时跳过,防重复)。 */
    forwardedInsertions = new Map();
    /** dsh attachments 服务面(单图入库;原生 read_image 同法)。 */
    attachmentsFace() {
        return this.ctx.get?.('attachments');
    }
    /** 标记一条插入为已转发;已标记过返回 false。 */
    markForwarded(sessionId, id) {
        let set = this.forwardedInsertions.get(sessionId);
        if (set === undefined) {
            set = new Set();
            this.forwardedInsertions.set(sessionId, set);
        }
        if (set.has(id))
            return false;
        set.add(id);
        while (set.size > CodebuddyLlmAdapter.FORWARDED_CAP) {
            const first = set.values().next().value;
            if (first === undefined)
                break;
            set.delete(first);
        }
        return true;
    }
    constructor(ctx, options) {
        super();
        this.ctx = ctx;
        this.options = options;
        this.conversations = options.store ?? new ConversationStore();
    }
    /**
     * 绑定模型元数据与分发流入口(rc.2+ 的 LlmAdapter 接口)。
     * 显式实现而非依赖基类:插件对宿主 dsh-llm 版本保持兼容
     * (rc.6 宿主不调用此方法;rc.2+ 宿主调用本实现)。
     */
    async prepareCall(provider, model, signal) {
        return {
            model: await this.resolveModel(provider, model, signal),
            stream: (options) => this.stream(options),
        };
    }
    /** 取(或建)某会话的 todo 状态;首建时从已提交事件折叠最新 todo/write 播种。 */
    todoStateFor(sessionId, session) {
        let state = this.todoStates.get(sessionId);
        if (state === undefined) {
            state = new TodoListState();
            state.seed(session?.ownEvents?.() ?? []);
            this.todoStates.set(sessionId, state);
        }
        return state;
    }
    async *stream(options) {
        // 会话绑定 + 调用方已打开 step(= agent-loop 的对话轮)→ 回合泵(路线 C1)。
        // 泵把「一次 CodeBuddy 模型调用」映射成一个 dsh step:本方法每个 step 调
        // 一次,返回当前模型调用的内容;工具调用由泵注册的回放工具在 loop 侧承接,
        // 原生写出 `assistant/message` / `tool/call` / `tool/result`。
        const sessionId = options.sessionId;
        if (options.purpose === undefined && sessionId !== undefined) {
            const session = this.ctx.get('sessions')?.get(sessionId);
            const ownEvents = (session?.ownEvents?.() ?? []);
            if (session !== undefined && findOpenStep(ownEvents) !== undefined) {
                const started = await this.startTurn(options, sessionId, session);
                if (started.kind === 'skip') {
                    // 本 step 输入全是「已插话投递」的消息:模型已在运行中读到并处理过它,
                    // 重启 CLI 再补发 CONTINUE_PROMPT 会把模型从插话上拽回旧任务(实测
                    // 踩坑:「插队没生效」的真凶)——空跑收尾。
                    steerDebug('空跑收尾:本 step 输入均为已插话投递的消息');
                    yield { type: 'finish', reason: { kind: 'stop' } };
                    return;
                }
                try {
                    yield* started.pump.attach();
                }
                finally {
                    // 回合被中止:泵(进程/计时器)一并收掉,避免残留。
                    if (options.signal?.aborted === true)
                        started.pump.dispose();
                }
                return;
            }
        }
        // 辅助调用(压缩/会话标题,带 purpose)与无会话调用:一次性旁路会话。
        yield* this.streamOneShot(options);
    }
    /**
     * 建立/复用本回合的泵(路线 C1)。同一回合内的每个 step 都到这里:
     * 已有泵 → 直接续段(绝不重发 prompt);没有 → 编译本轮输入并启动泵。
     */
    async startTurn(options, sessionId, childSession) {
        const existing = TurnPump.forSession(sessionId);
        if (existing !== undefined)
            return { kind: 'pump', pump: existing };
        const model = options.model ?? this.options.modelOf();
        const cwd = childSession.header.cwd ?? process.cwd();
        const isChild = childSession.header.parentSession !== undefined
            || childSession.header.origin === 'subagent';
        // 主代理轮不走 dsh 的 system prompt:它描述的是 CodeBuddy 调不到的 dsh
        // 工具(全权驱动语义,见 README)。子代理/未知名会话保持原样。
        const fullPromptOptions = !isChild
            ? { ...options, system: undefined }
            : options;
        const record = this.conversations.get(sessionId);
        let resume;
        let prompt;
        let images = [];
        if (record !== undefined) {
            // 补发缺失轮次:锚点(上次发送时的消息数)之后的消息里,跳过 CodeBuddy
            // 自己产生的 assistant/tool 消息,其余(其他模型的轮次、新输入、压缩
            // 摘要)全部序列化补发;已被插话投递过的消息不重复补发。
            const replay = await resumeReplayPrompt(this.ctx, options.messages, record.sentCount, this.forwardedInsertions.get(sessionId), record.lastSentMessageId);
            if (replay.skippedForwarded === true && record.sentCount !== undefined)
                return { kind: 'skip' };
            prompt = replay.prompt;
            images = replay.images;
            resume = { acpId: record.acpId };
        }
        else {
            // 新会话且带历史:把折叠后的历史转成 CodeBuddy 原生记录写成会话文件,
            // 以 session/load 载入——历史以原生消息进入,而不是压成一段提示词。
            const seed = await this.buildNativeSeed(options, cwd);
            if (seed !== undefined) {
                try {
                    writeConversationFile(seed.file, seed.records, { sessionId: seed.sessionId, cwd });
                    resume = { acpId: seed.sessionId };
                    const last = await lastUserPrompt(this.ctx, options.messages);
                    prompt = last.prompt;
                    images = last.images;
                }
                catch {
                    const built = await buildPrompt(this.ctx, fullPromptOptions);
                    prompt = built.prompt;
                    images = built.images;
                }
            }
            else {
                const built = await buildPrompt(this.ctx, fullPromptOptions);
                prompt = built.prompt;
                images = built.images;
            }
        }
        const attachments = this.attachmentsFace();
        const host = {
            ctx: this.ctx,
            command: this.options.command,
            prefixArgs: this.options.prefixArgs,
            extraArgs: this.options.extraArgs,
            ...options.reasoningEffort === undefined ? {} : { reasoningEffort: String(options.reasoningEffort) },
            ...this.options.timeouts === undefined ? {} : { timeouts: this.options.timeouts },
            ...this.options.maxAttempts === undefined ? {} : { maxAttempts: this.options.maxAttempts },
            ...this.options.retryDelayMs === undefined ? {} : { retryDelayMs: this.options.retryDelayMs },
            ...this.options.steerPollMs === undefined ? {} : { steerPollMs: this.options.steerPollMs },
            ...this.options.nativeBaseDir === undefined ? {} : { nativeBaseDir: this.options.nativeBaseDir },
            dshSessionId: sessionId,
            model,
            cwd,
            acpCwd: cwd,
            ...resume === undefined ? {} : { resume },
            prompt,
            images,
            fallbackPrompt: async () => {
                const built = await buildPrompt(this.ctx, fullPromptOptions);
                return { prompt: built.prompt, images: built.images };
            },
            rememberConversation: (acpId, sentCount, lastSentMessageId) => {
                this.conversations.set(sessionId, {
                    acpId,
                    sentCount,
                    ...(lastSentMessageId === undefined ? {} : { lastSentMessageId }),
                });
            },
            forgetConversation: () => { this.conversations.delete(sessionId); },
            sentCount: options.messages.length,
            // 补发主锚:本次发送覆盖到的最后一条消息(数量锚在压缩/编辑后不可靠——
            // 切到其他模型跑一段再切回时,数量锚越界会让补发退化成"只发最后一条")。
            ...(options.messages.length === 0
                ? {}
                : { sentLastMessageId: String(options.messages[options.messages.length - 1].id) }),
            session: {
                ownEvents: () => childSession.ownEvents?.() ?? [],
                ...childSession.append === undefined
                    ? {}
                    : { append: (type, data) => childSession.append?.(type, data) },
            },
            childSession: {
                header: {
                    ...childSession.header.agentPreset === undefined ? {} : { agentPreset: childSession.header.agentPreset },
                    ...childSession.header.delegationDepth === undefined ? {} : { delegationDepth: childSession.header.delegationDepth },
                },
            },
            attachmentsOf: () => attachments,
            todoStateOf: () => this.todoStateFor(sessionId, childSession),
            markForwarded: id => this.markForwarded(sessionId, id),
        };
        return { kind: 'pump', pump: new TurnPump(host, options.signal, { mirroredCalls: new Set(), maxGapMs: 0 }) };
    }
    /**
     * 原生种子:新会话且带历史时,把折叠后的历史转成 CodeBuddy 原生记录
     * (由调用方写成会话文件 + session/load 载入)。转换失败返回 undefined,
     * 调用方退回纯提示词路径。
     */
    async buildNativeSeed(options, cwd) {
        if (options.messages.length <= 1)
            return undefined;
        try {
            const sessionId = uuidv7();
            const attachments = this.ctx.get('attachments');
            const records = await messagesToRecords(options.messages.slice(0, -1), { sessionId, cwd }, attachments === undefined
                ? undefined
                : {
                    readImage: ref => attachments.readImage(ref),
                    ...this.options.nativeBaseDir === undefined ? {} : { blobsRoot: join(this.options.nativeBaseDir, '..', 'blobs') },
                });
            if (records.length === 0)
                return undefined;
            return { sessionId, file: conversationFilePath(sessionId, cwd, this.options.nativeBaseDir), records };
        }
        catch {
            return undefined;
        }
    }
    /**
     * 一次性旁路会话(带 purpose 的辅助调用 / 无会话调用)。可重试失败
     * (静默空跑/半途终止/进程退出/超时)时恢复同一会话续跑;用尽后以显式
     * 错误收尾。不写任何会话事件——调用方不是 agent-loop 的对话轮。
     */
    async *streamOneShot(options) {
        const maxAttempts = this.options.maxAttempts ?? 2;
        const retryDelayMs = this.options.retryDelayMs ?? 3_000;
        // attempt 之间共享已学到的进展间隔,避免每次 attempt 都从下限预算重新开始。
        const state = { maxGapMs: 0 };
        for (let attempt = 1;; attempt++) {
            const isLast = attempt >= maxAttempts;
            try {
                yield* this.oneShotOnce(options, state);
                return;
            }
            catch (error) {
                if (options.signal?.aborted)
                    return;
                if (!(error instanceof RetryableError) || isLast) {
                    yield {
                        type: 'finish',
                        reason: {
                            kind: 'error',
                            failure: {
                                message: (error instanceof Error ? error.message : String(error)).slice(0, 500),
                                code: 'CODEBUDDY_EXEC_ERROR',
                            },
                        },
                    };
                    return;
                }
                await new Promise(resolve => setTimeout(resolve, retryDelayMs));
                if (options.signal?.aborted)
                    return;
            }
        }
    }
    /** 单次旁路委托:进程 + 握手 + prompt + update 消费(纯 chunk,零会话写入)。 */
    async *oneShotOnce(options, state) {
        const { command, prefixArgs } = this.options;
        // 请求级 model 优先(子代理可经 agentOptions.model 动态指定),回退到当前默认模型。
        const model = options.model ?? this.options.modelOf();
        // 辅助调用(会话标题/压缩)是**旁路查询**:必须用一次性会话,绝不读写
        // 本会话的续接映射、也绝不原生种子——否则会抢写映射(实测:标题调用把
        // 映射覆盖成标题会话,镜像/续聊全部找错会话)并把旁路请求塞进真实对话。
        const purposeCall = options.purpose !== undefined;
        const dshSessionId = options.sessionId;
        const record = dshSessionId === undefined || purposeCall ? undefined : this.conversations.get(dshSessionId);
        const isResume = record !== undefined;
        const childSession = dshSessionId !== undefined && !purposeCall
            ? this.ctx.get('sessions')?.get(dshSessionId)
            : undefined;
        const cwd = childSession?.header.cwd ?? process.cwd();
        // 辅助调用(标题/压缩)在独立临时目录跑:一次性旁路会话不落进用户项目,
        // 避免 CodeBuddy 历史列表被标题小会话刷屏。
        const acpCwd = purposeCall ? purposeWorkDir() : cwd;
        const isChild = childSession?.header.parentSession !== undefined
            || childSession?.header.origin === 'subagent';
        // 主代理轮不走 dsh 的 system prompt(见 stream 路由注释)。
        const fullPromptOptions = !isChild
            ? { ...options, system: undefined }
            : options;
        let prompt;
        let promptImages = [];
        // 新会话且带历史:历史走原生会话文件(session/load)。
        let nativeSeed;
        if (!isResume && !purposeCall)
            nativeSeed = await this.buildNativeSeed(options, cwd);
        if (record !== undefined) {
            const replay = await resumeReplayPrompt(this.ctx, options.messages, record.sentCount, dshSessionId === undefined ? undefined : this.forwardedInsertions.get(dshSessionId), record.lastSentMessageId);
            prompt = replay.prompt;
            promptImages = replay.images;
            // 本 step 输入均为已插话投递的消息:空跑收尾(见 stream 路由注释)。
            if (replay.skippedForwarded === true && record.sentCount !== undefined) {
                steerDebug('空跑收尾(旁路):本 step 输入均为已插话投递的消息');
                yield { type: 'finish', reason: { kind: 'stop' } };
                return;
            }
        }
        else if (nativeSeed !== undefined) {
            const last = await lastUserPrompt(this.ctx, options.messages);
            prompt = last.prompt;
            promptImages = last.images;
        }
        else {
            const built = await buildPrompt(this.ctx, fullPromptOptions);
            prompt = built.prompt;
            promptImages = built.images;
        }
        try {
            // ── update 泵:回调把 update 推进队列,generator 在此处消费 ─────────
            // capturing 期间(initialize/new/load 完成之前)的 update 全部丢弃——
            // session/load 会同步回放历史事件,不能落地成新内容。
            let capturing = true;
            const queue = [];
            let wake;
            const onUpdate = (update) => {
                if (capturing)
                    return;
                queue.push(update);
                const w = wake;
                wake = undefined;
                w?.();
            };
            const waitForUpdate = async () => {
                if (queue.length > 0)
                    return;
                await new Promise(resolve => { wake = resolve; });
            };
            // ── 动态空闲超时:进展性 update 续命;两段收尾(cancel → kill) ──────
            const to = { ...DEFAULT_ACP_RUN_TIMEOUTS, ...this.options.timeouts };
            const startedAt = Date.now();
            let stallTimedOut = false;
            let killTimer;
            let maxGapMs = state.maxGapMs;
            let lastProgressAt = startedAt;
            let progressSamples = 0;
            let lastBudgetMs = to.idleMaxMs;
            let acpSessionId = '';
            let textLanded = 0;
            let toolsLanded = 0;
            /** 本次调用的最新一条用量样本(末位采样,不累加——累加会顶满上下文窗口)。 */
            let lastUsage;
            /** 在途工具(只有 start/complete 两个事件,长工具期间无心跳)。 */
            const pendingTools = new Set();
            /** 延写块:下一块到位时丢弃;流末的块走收尾 chunk(job 调用只要最终文本)。 */
            let pendingPiece;
            let currentStream;
            let nextBlockIndex = 0;
            /** 块收尾:闭合当前文本/思考块;上一块被替换(旁路调用只交付最后一块)。 */
            const flushPending = () => {
                if (currentStream === undefined)
                    return;
                const { index, text, chunks, blockType } = currentStream;
                const block = blockType === 'text' ? { type: 'text', text } : { type: 'reasoning', text };
                const closed = [...chunks, { type: 'block-end', index, block }];
                currentStream = undefined;
                if (text.length === 0)
                    return;
                if (blockType === 'text')
                    textLanded += 1;
                pendingPiece = { closed, block };
            };
            const releasePending = () => {
                if (pendingPiece === undefined)
                    return;
                pendingChunks.push(...pendingPiece.closed);
                pendingPiece = undefined;
            };
            const pendingChunks = [];
            const kill = () => { try {
                conn.kill();
            }
            catch { /* 已退出 */ } };
            const failStall = () => {
                stallTimedOut = true;
                // 第一段:协议级取消(CLI 事件循环若还活着就能收尾)。
                if (acpSessionId !== '')
                    conn.notify('session/cancel', { sessionId: acpSessionId });
                // 第二段:5s 仍无响应才杀进程——纯死挂只有这一条路。
                if (killTimer === undefined)
                    killTimer = setTimeout(kill, 5_000);
            };
            /**
             * 独立看门狗:与消费方是否还在迭代生成器无关(消费方被回收时生成器的
             * finally 可能永不执行——实测进程泄漏、子会话回合悬空)。静默判死已
             * 整体移除:CLI 等上游/长思考时可长时间零事件,只保留"在途工具永不
             * 返回"的硬顶;其余终止交给进程退出(挂起请求 reject)或调用方取消。
             */
            const guardTimer = setInterval(() => {
                if (stallTimedOut) {
                    clearInterval(guardTimer);
                    return;
                }
                if (pendingTools.size > 0) {
                    // 在途工具的硬顶兜底(cap<=0 = 关闭硬顶)。
                    const cap = to.guardCapMs ?? 30 * 60_000;
                    const idleFor = Date.now() - lastProgressAt;
                    if (cap > 0 && idleFor > cap)
                        failStall();
                }
            }, 3_000);
            guardTimer.unref?.();
            const armIdle = () => {
                const now = Date.now();
                maxGapMs = Math.max(maxGapMs, now - lastProgressAt);
                state.maxGapMs = maxGapMs;
                lastProgressAt = now;
                progressSamples += 1;
                lastBudgetMs = progressSamples <= to.idleWarmupLines
                    ? to.idleMaxMs
                    : Math.min(Math.max(maxGapMs * to.idleFactor, to.idleMinMs), to.idleMaxMs);
            };
            /** 处理一条 ACP update:续命 + 流累积(不写会话事件)。 */
            const handleUpdate = (update) => {
                if (isProgressUpdate(update))
                    armIdle();
                switch (update.sessionUpdate) {
                    case 'agent_thought_chunk':
                    case 'agent_message_chunk': {
                        const text = update.content?.text ?? '';
                        if (text.length === 0)
                            return;
                        const blockType = update.sessionUpdate === 'agent_thought_chunk' ? 'reasoning' : 'text';
                        const messageId = update.messageId ?? `${blockType}-anonymous`;
                        if (currentStream === undefined || currentStream.messageId !== messageId || currentStream.blockType !== blockType) {
                            flushPending();
                            currentStream = {
                                messageId,
                                blockType,
                                index: nextBlockIndex++,
                                text: '',
                                chunks: [{ type: 'block-start', index: nextBlockIndex - 1, blockType }],
                            };
                        }
                        currentStream.text += text;
                        currentStream.chunks.push({ type: 'text-delta', index: currentStream.index, text });
                        return;
                    }
                    case 'usage_update': {
                        const sample = usageOfUpdate(update);
                        if (sample === undefined)
                            return;
                        lastUsage = sample;
                        return;
                    }
                    case 'tool_call': {
                        if (update.toolCallId === undefined)
                            return;
                        if (pendingTools.has(update.toolCallId))
                            return;
                        const complete = update._meta?.['codebuddy.ai/toolArgumentsComplete'] === true
                            || update.status === 'pending';
                        if (!complete) {
                            pendingTools.add(update.toolCallId);
                            return;
                        }
                        pendingTools.delete(update.toolCallId);
                        toolsLanded += 1;
                        return;
                    }
                    case 'tool_call_update': {
                        if (update.toolCallId === undefined)
                            return;
                        if (update.status !== 'completed' && update.status !== 'failed')
                            return;
                        pendingTools.delete(update.toolCallId);
                        toolsLanded += 1;
                        return;
                    }
                    default:
                        return;
                }
            };
            // ── 建 ACP 进程 + 握手 + 会话 ────────────────────────────────────────
            // 推理强度:调用方选中的 effort 以 `--effort <level>` 传参(未选则保持 CLI 默认)。
            const effortArgs = options.reasoningEffort === undefined
                ? []
                : ['--effort', String(options.reasoningEffort)];
            // CLI 进程将在启动时读取 ~/.codebuddy/mcp.json 与 skills 目录:启动前
            // 同步一次(dsh 的 MCP 配置 / skills → CLI 原生通道),保证最新。
            syncCliIntegrations({ projectCwd: cwd });
            const conn = new AcpConnection([command, ...prefixArgs, '--acp', '--model', model, ...effortArgs, '--dangerously-skip-permissions', ...this.options.extraArgs], cwd, onUpdate);
            let exitError;
            conn.onExit(info => {
                if (conn.wasKilled || stallTimedOut)
                    return;
                exitError = new Error(`CodeBuddy ACP 进程退出(code ${info.code ?? 'null'}${info.signal !== null ? `,signal ${info.signal}` : ''})${conn.stderrNote()}`);
                const w = wake;
                wake = undefined;
                w?.();
            });
            // abort → 周期性 session/cancel(思考早期单次通知可能被吞,实测)。
            let cancelLoopTimer;
            const onAbort = () => {
                cancelLoopTimer = setInterval(() => {
                    if (acpSessionId !== '')
                        conn.notify('session/cancel', { sessionId: acpSessionId });
                }, 1_000);
            };
            options.signal?.addEventListener('abort', onAbort, { once: true });
            try {
                await conn.request('initialize', {
                    protocolVersion: 1,
                    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
                }, to.firstMs);
                if (isResume && record !== undefined && dshSessionId !== undefined) {
                    // 历史回放:load 响应前的 update 已被 capturing 丢弃。
                    try {
                        await conn.request('session/load', { sessionId: record.acpId, cwd: acpCwd, mcpServers: [] });
                        acpSessionId = record.acpId;
                    }
                    catch {
                        // CodeBuddy 侧会话存储丢失:回退新会话 + 完整历史重发。
                        this.conversations.delete(dshSessionId);
                        const full = await buildPrompt(this.ctx, fullPromptOptions);
                        prompt = full.prompt;
                        promptImages = full.images;
                        const created = await conn.request('session/new', { cwd: acpCwd, mcpServers: [] }, to.firstMs);
                        acpSessionId = created.sessionId;
                    }
                }
                else if (nativeSeed !== undefined) {
                    // 原生种子:写会话文件 + session/load(历史以原生消息进入)。
                    try {
                        writeConversationFile(nativeSeed.file, nativeSeed.records, { sessionId: nativeSeed.sessionId, cwd });
                        await conn.request('session/load', { sessionId: nativeSeed.sessionId, cwd: acpCwd, mcpServers: [] });
                        acpSessionId = nativeSeed.sessionId;
                    }
                    catch {
                        // 合成文件未被接受(未来版本变更等):退回新会话 + 全量提示词。
                        const full = await buildPrompt(this.ctx, fullPromptOptions);
                        prompt = full.prompt;
                        promptImages = full.images;
                        const created = await conn.request('session/new', { cwd: acpCwd, mcpServers: [] }, to.firstMs);
                        acpSessionId = created.sessionId;
                    }
                }
                else {
                    const created = await conn.request('session/new', { cwd: acpCwd, mcpServers: [] }, to.firstMs);
                    acpSessionId = created.sessionId;
                }
                // 记录/刷新续接锚点:sentCount = 本次实际发送时的 dsh 消息总数。
                if (dshSessionId !== undefined && !purposeCall) {
                    this.conversations.set(dshSessionId, { acpId: acpSessionId, sentCount: options.messages.length });
                }
                capturing = false;
                // ── prompt:消费 update 直到在飞 prompt 结束 ───────────────────────
                // session/prompt 是长活请求:不设请求超时(传 0),生命周期由动态空闲
                // 超时(cancel → kill → 进程退出 reject)与 abort 保护。
                let promptResult;
                let promptError;
                let inFlight = 0;
                const sendPrompt = (blocks) => {
                    inFlight += 1;
                    void conn.request('session/prompt', { sessionId: acpSessionId, prompt: blocks }, 0).then(v => { promptResult = v; }, e => { promptError = e instanceof Error ? e : new Error(String(e)); }).finally(() => { inFlight -= 1; });
                };
                sendPrompt([
                    { type: 'text', text: prompt },
                    ...promptImages.map(image => ({ type: 'image', data: image.data, mimeType: image.mimeType })),
                ]);
                pump: while (true) {
                    while (inFlight > 0 && promptError === undefined && exitError === undefined && !stallTimedOut) {
                        while (queue.length > 0) {
                            const update = queue.shift();
                            if (update !== undefined)
                                handleUpdate(update);
                        }
                        while (pendingChunks.length > 0)
                            yield pendingChunks.shift();
                        if (inFlight <= 0 || promptError !== undefined || exitError !== undefined || stallTimedOut)
                            break;
                        await Promise.race([waitForUpdate(), new Promise(resolve => setTimeout(resolve, 100))]);
                    }
                    while (queue.length > 0) {
                        const update = queue.shift();
                        if (update !== undefined)
                            handleUpdate(update);
                    }
                    while (pendingChunks.length > 0)
                        yield pendingChunks.shift();
                    break pump;
                }
                // 抽干尾部(cancel/exit 后可能还有少量 update)。
                while (queue.length > 0) {
                    const update = queue.shift();
                    if (update !== undefined)
                        handleUpdate(update);
                }
                while (pendingChunks.length > 0)
                    yield pendingChunks.shift();
                // 失败分类:可重试的走 RetryableError(外层恢复会话续跑)。
                if (stallTimedOut) {
                    flushPending();
                    throw new RetryableError(`CodeBuddy ACP 调用超时(已等待 ${Math.round((Date.now() - startedAt) / 1000)}s;`
                        + `在途工具 ${pendingTools.size} 个超过硬顶未返回,本次历史最大进展间隔 ${Math.round(maxGapMs / 1000)}s,`
                        + `已收 ${progressSamples} 次进展${conn.stderrNote()})`);
                }
                if (promptError !== undefined) {
                    throwFailure('CodeBuddy ACP 请求失败:', failureOfError(promptError), conn.stderrNote());
                }
                if (exitError !== undefined)
                    throw exitError;
                if (options.signal?.aborted === true) {
                    flushPending();
                    releasePending();
                    if (lastUsage !== undefined)
                        pendingChunks.push({ type: 'usage', usage: lastUsage });
                    while (pendingChunks.length > 0)
                        yield pendingChunks.shift();
                    return;
                }
                const stopReason = promptResult?.stopReason;
                // 失败详情优先取顶层 errorMessage;refusal 场景只有
                // `_meta["codebuddy.ai/errorMessage"]`(JSON:code/category/statusCode/
                // displayMsg 多语言文案)与 `codebuddy.ai/outcome`(FAILED_MODEL_REQUEST 等)。
                const metaError = promptResult?._meta?.['codebuddy.ai/errorMessage'];
                const metaOutcome = promptResult?._meta?.['codebuddy.ai/outcome'];
                const errorMessage = firstNonEmpty(promptResult?.errorMessage, typeof metaError === 'string' ? metaError : undefined);
                const failureOutcome = isFailureOutcome(metaOutcome) ? metaOutcome : undefined;
                flushPending();
                releasePending();
                if (lastUsage !== undefined)
                    pendingChunks.push({ type: 'usage', usage: lastUsage });
                while (pendingChunks.length > 0)
                    yield pendingChunks.shift();
                if (errorMessage !== undefined || failureOutcome !== undefined) {
                    throwFailure('CodeBuddy 中断:', parseCodebuddyFailure(errorMessage, undefined, failureOutcome), conn.stderrNote());
                }
                // 静默失败防御(实测高频):end_turn 但零思考、零文本、零工具。
                // 工具落地也算产出:纯工具轮次(无解说文本)是正常形态。
                if (stopReason !== 'cancelled' && (progressSamples === 0 || (textLanded === 0 && toolsLanded === 0))) {
                    throw new RetryableError(`CodeBuddy 静默失败(stopReason: ${stopReason ?? 'none'};`
                        + `${progressSamples} 次进展、0 次文本/工具产出)——可能是配额受限或服务端异常`);
                }
                // end_turn + 有产出,或 cancelled:正常收尾。
                yield {
                    type: 'finish',
                    reason: stopReason === 'max_tokens' || stopReason === 'max-tokens'
                        ? { kind: 'max-tokens' }
                        : { kind: 'stop' },
                };
            }
            finally {
                clearInterval(guardTimer);
                if (killTimer !== undefined)
                    clearTimeout(killTimer);
                if (cancelLoopTimer !== undefined)
                    clearInterval(cancelLoopTimer);
                options.signal?.removeEventListener('abort', onAbort);
                conn.kill();
            }
        }
        finally {
        }
    }
    resolveModel(provider, model, _signal) {
        return Promise.resolve({
            provider,
            id: model,
            name: model,
            // CodeBuddy 由内置模型驱动,支持文本与图像输入。
            inputModalities: ['text', 'image'],
            context: { contextWindow: 1_000_000 },
            // 推理强度:CLI `--effort` 的档位原样暴露(dsh 选择器/子代理 reasoning_effort
            // 参数据此校验与转发)。不设 defaultEffort:省略时保持 CLI 自身默认。
            reasoning: {
                efforts: CODEBUDDY_EFFORTS.map(effort => ({
                    id: ReasoningEffortId(effort.level),
                    name: effort.name,
                    description: effort.description,
                })),
            },
        });
    }
    /** 主模型选择器里的 provider 分组名。 */
    providerInfo(provider) {
        return { id: provider, name: 'CodeBuddy' };
    }
    /**
     * 主模型选择器的模型目录:`codebuddy --help` 解析出的 id ∪ 设置里的默认模型。
     *
     * 目录路径会在客户端每次拉取时被调用,且 CLI 可能缺失/挂起——因此
     * 异步 spawn + 超时、成功缓存 10 分钟、失败缓存 60 秒、并发合并,
     * 并且**永不抛错**:CLI 不可用时回退到配置模型,保证 provider 仍可选择。
     */
    async listModels(provider) {
        const now = Date.now();
        if (this.modelCache !== undefined && now - this.modelCache.at < SUCCESS_TTL_MS)
            return this.modelCache.models;
        if (this.modelFetch !== undefined)
            return this.modelFetch;
        const configured = this.options.modelOf();
        this.modelFetch = (async () => {
            try {
                const ids = await listCodebuddyModelIdsAsync(this.options.command, this.options.prefixArgs);
                const all = [...new Set([...ids, ...(configured.length > 0 ? [configured] : [])])];
                const models = all.map(id => ({ provider, id, name: id, description: `CodeBuddy (ACP) model ${id}` }));
                this.modelCache = { models, at: Date.now() };
                return models;
            }
            catch {
                const fallback = this.modelCache?.models
                    ?? (configured.length > 0 ? [{ provider, id: configured, name: configured }] : []);
                this.modelCache = { models: fallback, at: Date.now() - SUCCESS_TTL_MS + FAILURE_TTL_MS };
                return fallback;
            }
            finally {
                this.modelFetch = undefined;
            }
        })();
        return this.modelFetch;
    }
}
