/**
 * CodeBuddy 模型适配器:provider 路由 `codebuddy`,走 ACP(Agent Client Protocol)。
 *
 * 此前是 spawn `codebuddy -p` + 单向解析 stream-json:CLI 内部工具卡死时
 * 进程树杀不干净(工具子进程持有 stdout 写端),for-await 永久挂起,子代理
 * 假死且无任何错误反馈(实测,多机复现)。迁移到 ACP 后:
 *
 * - **会话生命周期官方化**:`session/new` / `session/load`(历史回放)复用
 *   长线会话;`session/prompt` 流式 `session/update`(含 thinking 流——
 *   单向 -p 模式没有的 agent_thought_chunk);
 * - **协议级取消**:`session/cancel` 对生成流与正在执行的工具都是即时抢占
 *   (实测),`stopReason: "cancelled"` 与正常结束明确区分;abort 信号驱动
 *   周期性重发(思考早期单次通知可能被吞);
 * - **静默失败自动重试**:CodeBuddy 服务端偶发静默失败(实测高频)——
 *   end_turn 但零思考零文本零工具、或只有思考没有产出。空跑会让主代理
 *   以为子代理完成了(用户看到"莫名中断、发继续没反应")。可重试失败
 *   自动恢复同一会话续跑(ACP session/load 回放),用尽才显式报错;
 * - **假死防御分层**:进展性 update(消息/思考/工具)重置动态空闲阈值;
 *   CLI 心跳(session_info/usage/config)与 stderr 不参与续命;静默超
 *   阈值先发 cancel、5s 仍无响应才 kill——进程退出码与 stderr 全程留证。
 * @module subagent-codebuddy/adapter
 */
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssistantStreamAccumulator, ReasoningEffortId, ToolCallId, LlmAdapter, createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm';
import { ConversationStore } from './conversations.js';
import { agentIdFromOutput, SubagentMirror } from './mirror.js';
import { conversationFilePath, messagesToRecords, uuidv7, writeConversationFile } from './native-session.js';
import { buildPrompt, lastUserPrompt, resumeReplayPrompt } from './serialize.js';
import { foldPendingInsertions } from './inbox.js';
import { todoToolKind, TodoListState } from './todo-bridge.js';
import { AcpConnection, DEFAULT_ACP_RUN_TIMEOUTS, isProgressUpdate, toolNameOf } from './acp.js';
import { failureOfError, formatFailureLine, isFailureOutcome, parseCodebuddyFailure } from './failure.js';
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
 * adapter 只在检测到调用方(agent-loop)已打开的 step 时直写事件——
 * 自己绝不创建 step,否则会与循环的 step 记账交错,破坏严格 v2 关系校验。
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
 * 识别 CodeBuddy Read 工具读图的原始输出。
 * 形态:`[{"type":"image_url","image_url":{"url":"data:image/png;base64,..."}}, ...]`
 * (部分版本为 JSON 字符串,数组内可混有 text 块)。非该形态返回 undefined,
 * 调用方保持原有纯文本路径。
 * @param outputText - tool/result 的原始输出文本。
 * @returns 解析出的文本与图片;不是图片输出时为 undefined。
 */
export function parseCodebuddyImageOutput(outputText) {
    const trimmed = outputText.trim();
    if (!trimmed.startsWith('[') || !trimmed.includes('image_url'))
        return undefined;
    let parsed;
    try {
        parsed = JSON.parse(trimmed);
    }
    catch {
        return undefined;
    }
    if (!Array.isArray(parsed))
        return undefined;
    const texts = [];
    const images = [];
    for (const item of parsed) {
        if (item === null || typeof item !== 'object')
            continue;
        const record = item;
        if (record['type'] === 'text' && typeof record['text'] === 'string') {
            texts.push(record['text']);
            continue;
        }
        if (record['type'] !== 'image_url')
            continue;
        const url = record['image_url']?.['url'];
        if (typeof url !== 'string')
            continue;
        const match = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,(.*)$/is.exec(url);
        if (match === null)
            continue;
        images.push({ data: new Uint8Array(Buffer.from(match[2], 'base64')), mediaType: match[1] });
    }
    if (images.length === 0)
        return undefined;
    return { text: texts.join('\n'), images };
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
        yield* this.streamWithRetry(options);
    }
    /**
     * 带重试的委托执行。可重试失败(静默空跑/半途终止/进程退出/超时)时
     * 恢复同一会话续跑;用尽后以显式错误收尾,让主代理知道子代理实际状态。
     */
    async *streamWithRetry(options) {
        const maxAttempts = this.options.maxAttempts ?? 2;
        const retryDelayMs = this.options.retryDelayMs ?? 3_000;
        // 会话级状态跨 attempt 连续(重试的续跑是同一子代理任务的延续);
        // maxGapMs 同享:重试不应忘掉已学到的进展间隔,否则每次 attempt 都从
        // 下限预算重新开始,长任务会被反复误杀。
        const stepState = {
            toolCallSeqs: new Map(),
            consumedToolCalls: new Set(),
            mirroredCalls: new Set(),
            maxGapMs: 0,
        };
        for (let attempt = 1;; attempt++) {
            const isLast = attempt >= maxAttempts;
            try {
                yield* this.streamOnce(options, attempt, stepState);
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
    /** 单次委托尝试:进程 + 握手 + prompt + update 消费。 */
    async *streamOnce(options, attempt, stepState) {
        const { command, prefixArgs } = this.options;
        // 请求级 model 优先(子代理可经 agentOptions.model 动态指定),回退到当前默认模型。
        const model = options.model ?? this.options.modelOf();
        // 辅助调用(会话标题/压缩)是**旁路查询**:必须用一次性会话,绝不读写
        // 本会话的续接映射、也绝不原生种子——否则会抢写映射(实测:标题调用把
        // 映射覆盖成标题会话,镜像/续聊全部找错会话)并把旁路请求塞进真实对话。
        const purposeCall = options.purpose !== undefined;
        // 会话复用:同一会话映射到同一个 CodeBuddy ACP 会话(映射持久化,重启可恢复)。
        const dshSessionId = options.sessionId;
        const record = dshSessionId === undefined || purposeCall ? undefined : this.conversations.get(dshSessionId);
        const isResume = record !== undefined;
        // 工作目录对齐子代理会话的工作区,保证文件操作发生在正确目录。
        const childSession = options.sessionId !== undefined ? this.ctx.get('sessions')?.get(options.sessionId) : undefined;
        const cwd = childSession?.header.cwd ?? process.cwd();
        // 辅助调用(标题/压缩)在独立临时目录跑:一次性旁路会话不落进用户项目,
        // 避免 CodeBuddy 历史列表被标题小会话刷屏。
        const acpCwd = purposeCall ? purposeWorkDir() : cwd;
        const isChild = childSession?.header.parentSession !== undefined
            || childSession?.header.origin === 'subagent';
        // 主代理轮不走 dsh 的 system prompt:它描述的是 CodeBuddy 调不到的 dsh
        // 工具(全权驱动语义,见 README)。子代理/未知名会话保持原样。
        const fullPromptOptions = !isChild
            ? { ...options, system: undefined }
            : options;
        let prompt;
        let promptImages = [];
        // 新会话且带历史:把折叠后的历史转成 CodeBuddy 原生记录写成会话文件,
        // 以 session/load 载入——历史以原生消息进入,而不是压成一段提示词。
        let nativeSeed;
        if (!isResume && !purposeCall && dshSessionId !== undefined && options.messages.length > 1) {
            // 转换失败(附件/blob IO 等)不能拖垮整轮:退回纯提示词路径。
            try {
                const sessionId = uuidv7();
                const attachments = this.ctx.get('attachments');
                const records = await messagesToRecords(options.messages.slice(0, -1), { sessionId, cwd }, attachments === undefined
                    ? undefined
                    : {
                        readImage: ref => attachments.readImage(ref),
                        ...(this.options.nativeBaseDir !== undefined ? { blobsRoot: join(this.options.nativeBaseDir, '..', 'blobs') } : {}),
                    });
                if (records.length > 0) {
                    nativeSeed = {
                        sessionId,
                        file: conversationFilePath(sessionId, cwd, this.options.nativeBaseDir),
                        records,
                    };
                }
            }
            catch { /* 原生种子不可用:走提示词路径 */ }
        }
        if (record !== undefined) {
            // 补发缺失轮次:锚点(上次发送时的消息数)之后的消息里,跳过 CodeBuddy
            // 自己产生的 assistant/tool 消息,其余(其他模型的轮次、新输入、压缩
            // 摘要)全部序列化补发。锚点缺失/历史收缩时退回最后一条用户消息。
            const replay = await resumeReplayPrompt(this.ctx, options.messages, record.sentCount, dshSessionId === undefined ? undefined : this.forwardedInsertions.get(dshSessionId));
            prompt = replay.prompt;
            promptImages = replay.images;
        }
        else if (nativeSeed !== undefined) {
            // 历史走原生文件;prompt 只带当前输入(含其图片,原生内容块)。
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
            let firstTimer;
            let idleTimer;
            let killTimer;
            let maxGapMs = stepState.maxGapMs;
            let lastProgressAt = startedAt;
            let progressSamples = 0;
            let lastBudgetMs = to.idleMaxMs;
            let acpSessionId = '';
            let textLanded = 0;
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
            const touch = () => {
                if (firstTimer !== undefined) {
                    clearTimeout(firstTimer);
                    firstTimer = undefined;
                }
                if (idleTimer !== undefined)
                    clearTimeout(idleTimer);
                idleTimer = setTimeout(failStall, lastBudgetMs);
            };
            /**
             * 独立看门狗:与消费方(agent-loop)是否还在迭代生成器无关。
             * 消费方被回收时生成器的 finally 可能永不执行——实测(后台子代理被
             * 遗弃):CodeBuddy 进程泄漏、子会话回合悬空,侧边栏冷读判定"目录损坏"。
             * 静默超预算直接强杀:conn 的挂起请求随之 reject,上游能收尾回合。
             */
            const guardTimer = setInterval(() => {
                // stall 已触发(或消费方被回收后)自清:避免遗弃流里看门狗永远空转。
                if (stallTimedOut) {
                    clearInterval(guardTimer);
                    return;
                }
                const idleFor = Date.now() - lastProgressAt;
                if (pendingToolCalls.size > 0) {
                    // 在途工具期间主逻辑暂停计时(长工具无心跳),这里只设硬顶兜底。
                    // 只咬「完全静默」的工具段:任何 tool_call_update/文本/思考都会重置
                    // 计时(会冒泡的长工具不受影响)。guardCapMs<=0 = 关闭硬顶(接受
                    // 进程泄漏风险,换「永不误杀」)。
                    const cap = to.guardCapMs ?? 30 * 60_000;
                    if (cap > 0 && idleFor > cap)
                        failStall();
                    return;
                }
                if (idleFor > lastBudgetMs)
                    failStall();
            }, 3_000);
            guardTimer.unref?.();
            const armIdle = () => {
                const now = Date.now();
                maxGapMs = Math.max(maxGapMs, now - lastProgressAt);
                stepState.maxGapMs = maxGapMs;
                lastProgressAt = now;
                progressSamples += 1;
                // 工具在途(tool_call 已到、completion 未到)期间暂停空闲计时:ACP 的
                // 工具只有 start/complete 两个事件,长工具(分钟级)中途没有任何心跳,
                // 任何预算上限都会把正常运行的子代理误判为静默。工具收尾后重新起算。
                if (pendingToolCalls.size > 0) {
                    if (idleTimer !== undefined) {
                        clearTimeout(idleTimer);
                        idleTimer = undefined;
                    }
                    return;
                }
                lastBudgetMs = progressSamples <= to.idleWarmupLines
                    ? to.idleMaxMs
                    : Math.min(Math.max(maxGapMs * to.idleFactor, to.idleMinMs), to.idleMaxMs);
                touch();
            };
            // ── 写入模式 ────────────────────────────────────────────────────────
            // direct:调用方(agent-loop)已打开一个 step(主/子代理的对话轮),adapter
            //   把 ACP 的思考/文本/工具事件直写进该 step——自己绝不创建或关闭 step,
            //   否则会与循环的记账交错,破坏严格 v2 关系校验(step/end 必须匹配
            //   当前打开的 step;tool/call 必须被先前的 assistant/message 广告)。
            // stream:辅助调用(compaction/session-title 带 purpose)或无会话/无打开
            //   step——不写任何会话事件,把 ACP 文本转成真实 chunk 吐回调用方。
            const session = childSession;
            const openStep = session === undefined ? undefined : findOpenStep(session.ownEvents?.() ?? []);
            const direct = options.purpose === undefined && session !== undefined && openStep !== undefined;
            const turn = openStep?.turn ?? 1;
            const step = openStep?.step ?? 1;
            const pendingToolCalls = new Map();
            /** 跨 attempt:已收尾(补过错误 result)的工具调用,续跑时不再二次落地。 */
            const consumedToolCalls = stepState.consumedToolCalls;
            const pendingChunks = [];
            /** 延写块:下一块到位时持久化;流末的暂存块走循环收尾消息。 */
            let pendingPiece;
            /** CodeBuddy 子代理调用(callId → 影子会话镜像)。 */
            const mirrors = new Map();
            const subagentCallIds = new Set();
            /** CodeBuddy 任务/todo 工具 → dsh `todo/write` 整表事件(UI 的 TodoPanel)。 */
            const todoState = direct && dshSessionId !== undefined
                ? this.todoStateFor(dshSessionId, session)
                : undefined;
            let currentStream;
            let nextBlockIndex = 0;
            /**
             * 块收尾:闭合当前文本/思考块,**延写一块**。
             *
             * 设计(三轮迭代后的定稿):
             * - 每块先暂存;下一块收尾时才把它**持久化**(surface append)——侧边栏
             *   子代理视图/历史视图只读持久事件,运行中即时可见;
             * - **最后一块永不持久化**,由 {@link releasePending} 作为 chunk 交给
             *   agent-loop:它在流结束写唯一一条收尾消息(=最后一块文本)。对话视图
             *   与子代理视图最终取的就是这条(非空,不会再被"空收尾消息"吞掉);
             *   模型派生 = 分块(1..N-1)+ 收尾块(N)= 全文恰好一次,零重复。
             * 每块内容只出现一次:要么持久化(较早块),要么走收尾(yielding,最后块)。
             */
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
                if (pendingPiece !== undefined)
                    writePiece(pendingPiece);
                pendingPiece = { closed, block };
            };
            /** 持久化一个延写块(surface append;纯展示与历史用,不 yield 给循环)。 */
            const writePiece = (piece) => {
                if (!direct)
                    return;
                try {
                    const accumulator = new AssistantStreamAccumulator();
                    for (const chunk of piece.closed) {
                        accumulator.push({ time: Date.now(), chunk });
                    }
                    session.append('assistant/message', {
                        turn,
                        step,
                        message: createAssistantMessage({
                            content: [piece.block],
                            source: { provider: options.provider ?? 'codebuddy', model },
                        }),
                        stream: [...accumulator.snapshot()],
                    }, { surfaceOp: 'append' });
                }
                catch { /* 日志面失败不影响流 */ }
            };
            /**
             * 流结束时把暂存块交给循环(其收尾消息即最后一块文本)。
             * 正常/中止路径调用;异常(重试)路径经 finalizePendingTools 落成持久块。
             */
            const releasePending = () => {
                if (pendingPiece === undefined)
                    return;
                pendingChunks.push(...pendingPiece.closed);
                pendingPiece = undefined;
            };
            /**
             * 落地一次工具调用:先广告(严格校验要求 tool/call 的 name/arguments 与
             * 前置 assistant/message 的 tool-call 块逐字一致),再写 tool/call。
             * @returns tool/call 的事件 seq,未落地时为 undefined。
             */
            const landToolCall = (callId, name, args) => {
                flushPending();
                session.append('assistant/message', {
                    turn,
                    step,
                    message: createAssistantMessage({
                        content: [{ type: 'tool-call', id: ToolCallId(callId), name, arguments: args }],
                        source: { provider: options.provider ?? 'codebuddy', model },
                    }),
                    stream: [],
                }, { surfaceOp: 'append' });
                const ev = session.append('tool/call', {
                    turn,
                    step,
                    callId: ToolCallId(callId),
                    name,
                    arguments: args,
                });
                if (ev !== undefined)
                    stepState.toolCallSeqs.set(callId, ev.seq);
                return ev?.seq;
            };
            /** 写一条工具结果(截断 2000 字符;failed/未完成 → isError)。
             * CodeBuddy Read 工具读取图片时 rawOutput.text 是
             * `[{"type":"image_url","image_url":{"url":"data:image/png;base64,..."}}]`
             * 形态的 JSON:识别后把图片存进附件服务,落成 dsh 原生 image 块
             * (UI 渲染缩略图、可点击看大图),而不是把 base64 原样铺进文本。 */
            const landToolResult = (callId, outputText, isError) => {
                const seq = stepState.toolCallSeqs.get(callId);
                const sourceOptions = {
                    surfaceOp: 'append',
                    ...(seq !== undefined ? { sourceEventSeqs: [seq] } : {}),
                };
                const parsedImage = parseCodebuddyImageOutput(outputText);
                if (parsedImage === undefined) {
                    session.append('tool/result', {
                        turn,
                        step,
                        message: createToolResultMessage({
                            callId: ToolCallId(callId),
                            content: [{ type: 'text', text: outputText.slice(0, 2000) }],
                            isError,
                        }),
                    }, sourceOptions);
                    return;
                }
                return (async () => {
                    const attachments = this.ctx.get('attachments');
                    const blocks = [{
                            type: 'text',
                            text: parsedImage.text.length > 0
                                ? parsedImage.text.slice(0, 2000)
                                : `[图片输出:${parsedImage.images.length} 张]`,
                        }];
                    for (const image of parsedImage.images) {
                        if (attachments === undefined) {
                            blocks.push({ type: 'text', text: '[图片无法显示:附件服务不可用]' });
                            continue;
                        }
                        try {
                            const ref = await attachments.saveImage(image);
                            blocks.push({ type: 'image', attachment: ref });
                        }
                        catch (error) {
                            const message = error instanceof Error ? error.message : String(error);
                            blocks.push({ type: 'text', text: `[图片保存失败:${message.slice(0, 300)}]` });
                        }
                    }
                    session.append('tool/result', {
                        turn,
                        step,
                        message: createToolResultMessage({
                            callId: ToolCallId(callId),
                            content: blocks,
                            isError,
                        }),
                    }, sourceOptions);
                })();
            };
            /**
             * 收尾所有未完成的工具调用:补广告 + call + 错误 result。
             * 保证调用方闭合 step 时没有未决工具生命周期(严格校验要求),
             * 同时把已收尾的 callId 记入跨 attempt 集合,续跑时不重复落地。
             * 顺带收尾所有子代理镜像(未收到完成更新时终读并闭合影子会话)。
             */
            const finalizePendingTools = () => {
                // 异常/重试路径没有循环收尾消息:暂存块落成持久块(不丢文本)。
                if (pendingPiece !== undefined) {
                    writePiece(pendingPiece);
                    pendingPiece = undefined;
                }
                for (const mirror of mirrors.values())
                    void mirror.finish();
                mirrors.clear();
                if (!direct)
                    return;
                for (const [callId, entry] of pendingToolCalls) {
                    if (!entry.landed) {
                        entry.landed = true;
                        landToolCall(callId, entry.name, JSON.stringify(entry.rawInput));
                    }
                    void landToolResult(callId, 'CodeBuddy turn ended before this tool reported completion.', true);
                    consumedToolCalls.add(callId);
                }
                pendingToolCalls.clear();
            };
            /** 子代理调用(Agent 工具):启动影子会话镜像(侧边栏子代理视图)。 */
            const maybeStartMirror = (callId, entry) => {
                if (!direct || !subagentCallIds.has(callId) || mirrors.has(callId))
                    return;
                // 跨 attempt 去重:静默失败重试会让同一调用再次经过这里,不能建第二个影子会话。
                if (stepState.mirroredCalls.has(callId))
                    return;
                if (dshSessionId === undefined || acpSessionId === '')
                    return;
                const sessions = this.ctx.get('sessions');
                if (sessions?.create === undefined)
                    return;
                const description = entry.rawInput['description'];
                const prompt = entry.rawInput['prompt'];
                const attachments = this.ctx.get('attachments');
                const mirror = new SubagentMirror({
                    sessions: sessions,
                    parentSessionId: dshSessionId,
                    cwd,
                    acpSessionId,
                    ...(this.options.nativeBaseDir !== undefined ? { projectsRoot: this.options.nativeBaseDir } : {}),
                    ...(childSession?.header?.agentPreset === undefined
                        ? {}
                        : { agentPreset: childSession.header.agentPreset }),
                    ...(attachments === undefined
                        ? {}
                        : { attachments: { saveImage: (data, mediaType) => attachments.saveImage({ data, mediaType }) } }),
                });
                mirror.start({
                    label: typeof description === 'string' && description.length > 0 ? description : 'CodeBuddy 子代理',
                    prompt: typeof prompt === 'string' ? prompt : '',
                    delegationDepth: (childSession?.header?.delegationDepth ?? 0) + 1,
                });
                mirrors.set(callId, mirror);
                stepState.mirroredCalls.add(callId);
            };
            /** 子代理调用结束:终读转录并闭合影子会话。 */
            const finishMirror = (callId, outputText) => {
                const mirror = mirrors.get(callId);
                if (mirror === undefined)
                    return;
                void mirror.finish(agentIdFromOutput(outputText));
                mirrors.delete(callId);
            };
            /** 落地一次 todo 整表快照(展示性桥接,失败不阻断对话)。 */
            const emitTodo = () => {
                if (todoState === undefined)
                    return;
                try {
                    // 'todo/write' 是核心已知事件(log-only UI 状态);插件依赖的 dsh-session
                    // 类型表未含该 augmentation,窄化 session 面以落事件。
                    const writer = session;
                    writer.append('todo/write', { todos: todoState.snapshot() });
                }
                catch { /* 展示性桥接不阻断对话 */ }
            };
            /** CodeBuddy 任务工具 → 折算整表(TaskUpdate 延到结果确认后折算)。 */
            const landTodo = (callId, name, rawInput) => {
                if (todoState === undefined)
                    return;
                const kind = todoToolKind(name);
                if (kind === undefined)
                    return;
                try {
                    if (kind === 'taskupdate') {
                        todoState.deferTaskUpdate(callId, rawInput);
                        return;
                    }
                    if (todoState.applyToolCall(name, rawInput))
                        emitTodo();
                }
                catch { /* 展示性桥接不阻断对话 */ }
            };
            /** 工具结果确认:TaskCreate 绑定 id;TaskUpdate 仅成功(Updated task)才折算。 */
            const confirmTodo = (callId, name, text) => {
                if (todoState === undefined || todoToolKind(name) === undefined)
                    return;
                try {
                    todoState.applyToolResult(name, text);
                    if (todoState.resolveTaskUpdate(callId, text))
                        emitTodo();
                }
                catch { /* 展示性桥接不阻断对话 */ }
            };
            /** 处理一条 ACP update:续命 + 会话事件落地 + 流累积。 */
            const handleUpdate = async (update) => {
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
                    case 'tool_call': {
                        if (update.toolCallId === undefined)
                            return;
                        if (consumedToolCalls.has(update.toolCallId))
                            return;
                        // CodeBuddy 子代理委派(Agent 工具):标记,落地时启动影子会话镜像。
                        if (update._meta?.['codebuddy.ai/isSubagent'] === true)
                            subagentCallIds.add(update.toolCallId);
                        const name = toolNameOf(update);
                        const rawInput = update.rawInput ?? {};
                        // 参数完整性:in_progress 阶段 rawInput 是空壳(参数流式生成中),
                        // 等 pending(toolArgumentsComplete)再落地——否则 UI 只能看到 {}。
                        const complete = update._meta?.['codebuddy.ai/toolArgumentsComplete'] === true
                            || update.status === 'pending';
                        const known = pendingToolCalls.get(update.toolCallId);
                        if (known === undefined) {
                            pendingToolCalls.set(update.toolCallId, { name, rawInput, landed: false });
                            // 在途工具即刻暂停空闲计时(switch 前的 armIdle 还不知道它存在)。
                            armIdle();
                            if (!complete)
                                return;
                        }
                        const entry = pendingToolCalls.get(update.toolCallId);
                        if (entry.landed)
                            return;
                        entry.landed = true;
                        entry.rawInput = Object.keys(entry.rawInput).length > 0 ? entry.rawInput : rawInput;
                        // stream 模式:工具由 CodeBuddy 自己执行,不落 dsh 会话事件。
                        if (!direct)
                            return;
                        landToolCall(update.toolCallId, entry.name, JSON.stringify(entry.rawInput));
                        landTodo(update.toolCallId, entry.name, entry.rawInput);
                        maybeStartMirror(update.toolCallId, entry);
                        return;
                    }
                    case 'tool_call_update': {
                        if (update.toolCallId === undefined)
                            return;
                        if (update.status !== 'completed' && update.status !== 'failed')
                            return;
                        if (consumedToolCalls.has(update.toolCallId))
                            return;
                        if (update._meta?.['codebuddy.ai/isSubagent'] === true)
                            subagentCallIds.add(update.toolCallId);
                        let known = pendingToolCalls.get(update.toolCallId);
                        if (known === undefined) {
                            // 兜底:call 事件从未落地(缺 pending 直达 completed 的路径),
                            // 用 update 自带的 rawInput 补落,保证 tool/result 总有配对的 call。
                            known = { name: toolNameOf(update), rawInput: update.rawInput ?? {}, landed: false };
                            pendingToolCalls.set(update.toolCallId, known);
                        }
                        if (!known.landed && direct) {
                            known.landed = true;
                            landToolCall(update.toolCallId, known.name, JSON.stringify(known.rawInput));
                            landTodo(update.toolCallId, known.name, known.rawInput);
                            maybeStartMirror(update.toolCallId, known);
                        }
                        pendingToolCalls.delete(update.toolCallId);
                        // 工具收尾:退回动态预算(此更新本身是进展,计时从此刻重新起算)。
                        armIdle();
                        if (!direct)
                            return;
                        flushPending();
                        await landToolResult(update.toolCallId, update.rawOutput?.text ?? '', update.status === 'failed');
                        confirmTodo(update.toolCallId, known.name, update.rawOutput?.text ?? '');
                        finishMirror(update.toolCallId, update.rawOutput?.text ?? '');
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
            const conn = new AcpConnection([command, ...prefixArgs, '--acp', '--model', model, ...effortArgs, '--dangerously-skip-permissions', ...this.options.extraArgs], cwd, onUpdate);
            touch();
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
                // 记录/刷新续接锚点:sentCount = 本次实际发送时的 dsh 消息总数,
                // 未来续聊从此处切片补发(含重启恢复的场景)。
                if (dshSessionId !== undefined && !purposeCall) {
                    this.conversations.set(dshSessionId, { acpId: acpSessionId, sentCount: options.messages.length });
                }
                capturing = false;
                // ── prompt:消费 update 直到所有在飞 prompt 结束 ─────────────────────
                // session/prompt 是长活请求:不设请求超时(传 0),生命周期由动态空闲
                // 超时(cancel → kill → 进程退出 reject)与 abort 保护——固定超时会
                // 误杀长任务(实测 180s 掐死 3 分钟以上的任务)。
                // 中途插入:飞行中再发 session/prompt 会被 CodeBuddy 排队(实测),
                // 当前工作完成后立即处理——用于转发 dsh inbox 里尚未 claim 的用户消息。
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
                /** 轮询间隔(中途插入检测)。 */
                const steerPollMs = this.options.steerPollMs ?? 1_200;
                let lastSteerPoll = Date.now();
                while (inFlight > 0 && promptError === undefined && exitError === undefined && !stallTimedOut) {
                    while (queue.length > 0) {
                        const update = queue.shift();
                        if (update !== undefined)
                            await handleUpdate(update);
                    }
                    while (pendingChunks.length > 0)
                        yield pendingChunks.shift();
                    // 中途插入检测:dsh inbox 里尚未 claim 的用户消息 → 排队转发。
                    if (direct && dshSessionId !== undefined && session !== undefined
                        && options.signal?.aborted !== true && Date.now() - lastSteerPoll >= steerPollMs) {
                        lastSteerPoll = Date.now();
                        try {
                            for (const insertion of foldPendingInsertions(session.ownEvents?.() ?? [])) {
                                if (!this.markForwarded(dshSessionId, insertion.id))
                                    continue;
                                sendPrompt([{ type: 'text', text: insertion.text }]);
                                armIdle();
                            }
                        }
                        catch { /* 插入检测不阻断主流程 */ }
                    }
                    if (inFlight <= 0 || promptError !== undefined || exitError !== undefined || stallTimedOut)
                        break;
                    await Promise.race([waitForUpdate(), new Promise(resolve => setTimeout(resolve, 100))]);
                }
                // 抽干尾巴(cancel/exit 后可能还有少量 update)。
                while (queue.length > 0) {
                    const update = queue.shift();
                    if (update !== undefined)
                        await handleUpdate(update);
                }
                while (pendingChunks.length > 0)
                    yield pendingChunks.shift();
                // 失败分类:可重试的走 RetryableError(外层恢复会话续跑)。
                if (stallTimedOut) {
                    finalizePendingTools();
                    throw new RetryableError(`CodeBuddy ACP 调用超时(已等待 ${Math.round((Date.now() - startedAt) / 1000)}s;`
                        + `静默超过 ${Math.round(lastBudgetMs / 1000)}s 无进展,本次历史最大进展间隔 ${Math.round(maxGapMs / 1000)}s,`
                        + `阈值 = clamp(间隔 × ${to.idleFactor}, ${Math.round(to.idleMinMs / 1000)}s, ${Math.round(to.idleMaxMs / 1000)}s),`
                        + `已收 ${progressSamples} 次进展,在途工具 ${pendingToolCalls.size} 个${conn.stderrNote()})`);
                }
                if (promptError !== undefined) {
                    finalizePendingTools();
                    throwFailure('CodeBuddy ACP 请求失败:', failureOfError(promptError), conn.stderrNote());
                }
                if (exitError !== undefined) {
                    finalizePendingTools();
                    throw exitError;
                }
                if (options.signal?.aborted === true) {
                    // 中止:已交付的文本/思考前缀按 0.1.3 语义标 interrupted 落地;
                    // 在途工具补错误 result,调用方闭合 step 时无未决生命周期。
                    flushPending();
                    releasePending();
                    while (pendingChunks.length > 0)
                        yield pendingChunks.shift();
                    finalizePendingTools();
                    return;
                }
                const stopReason = promptResult?.stopReason;
                // 失败详情优先取顶层 errorMessage;refusal 场景只有
                // _meta["codebuddy.ai/errorMessage"](JSON:code/category/statusCode/
                // displayMsg 多语言文案)与 "codebuddy.ai/outcome"(FAILED_MODEL_REQUEST 等)。
                const metaError = promptResult?._meta?.['codebuddy.ai/errorMessage'];
                const metaOutcome = promptResult?._meta?.['codebuddy.ai/outcome'];
                const rawError = firstNonEmpty(promptResult?.errorMessage, typeof metaError === 'string' ? metaError : undefined);
                const failureOutcome = isFailureOutcome(metaOutcome) ? metaOutcome : undefined;
                flushPending();
                releasePending();
                // stream 模式的收尾块在最后一次泵之后才产生,这里补泵(compaction/标题)。
                while (pendingChunks.length > 0)
                    yield pendingChunks.shift();
                if (rawError !== undefined || failureOutcome !== undefined) {
                    finalizePendingTools();
                    throwFailure('CodeBuddy 中断:', parseCodebuddyFailure(rawError, undefined, failureOutcome), conn.stderrNote());
                }
                // 静默失败防御(实测高频):end_turn 但零思考、零文本、零工具——无错误
                // 详情上报的空跑,多为服务端异常;或只有思考没有产出(半途失败)。
                // 空跑会让主代理以为子代理完成了,用户看到"莫名中断"。
                if (stopReason !== 'cancelled' && (progressSamples === 0 || textLanded === 0)) {
                    finalizePendingTools();
                    throw new RetryableError(`CodeBuddy 静默失败(stopReason: ${stopReason ?? 'none'};`
                        + `${progressSamples} 次进展、0 次文本产出;无错误详情上报)`);
                }
                finalizePendingTools();
                // end_turn + 有文本产出,或 cancelled:正常收尾。
                yield {
                    type: 'finish',
                    reason: stopReason === 'max_tokens' || stopReason === 'max-tokens'
                        ? { kind: 'max-tokens' }
                        : { kind: 'stop' },
                };
            }
            finally {
                clearInterval(guardTimer);
                if (firstTimer !== undefined)
                    clearTimeout(firstTimer);
                if (idleTimer !== undefined)
                    clearTimeout(idleTimer);
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
