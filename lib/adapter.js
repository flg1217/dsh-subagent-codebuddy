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
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssistantStreamAccumulator, ReasoningEffortId, ToolCallId, LlmAdapter, createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm';
import { ConversationStore } from './conversations.js';
import { agentIdFromOutput, SubagentMirror } from './mirror.js';
import { conversationFilePath, messagesToRecords, uuidv7, writeConversationFile } from './native-session.js';
import { buildPrompt, lastUserPrompt, resumeReplayPrompt } from './serialize.js';
import { foldPendingInsertions } from './inbox.js';
import { todoToolKind, TodoListState } from './todo-bridge.js';
import { imageReadAlias, toolResultBlocksFromText } from './tool-image.js';
import { AcpConnection, DEFAULT_ACP_RUN_TIMEOUTS, isProgressUpdate, toolNameOf, usageOfUpdate } from './acp.js';
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
            // 这一步的输入只有"我们已在运行中插话投递过"的消息(dsh 在回合边界把
            // 那条插话 claim 成了新 step)。模型已经处理过它,再发
            // `CONTINUE_PROMPT`("继续完成之前未完成的任务")会把模型从插话上拽回
            // 旧任务——实测:插话送达成功(steered:true、注入成 user 消息、模型开始
            // 响应),随后被这句催跑覆盖,用户看到的现象是"插队没生效"。
            // 空跑收尾:不启动 CLI、不写任何内容,循环以空 assistant 消息闭合该 step。
            if (replay.skippedForwarded === true && record.sentCount !== undefined) {
                steerDebug(`空跑收尾:本 step 输入均为已插话投递的消息(sentCount=${record.sentCount})`);
                yield { type: 'finish', reason: { kind: 'stop' } };
                return;
            }
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
                lastUpdateAt = Date.now();
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
            let toolsLanded = 0;
            /**
             * 本 step 的最新一条用量样本(`usage_update`)。
             *
             * **必须末位采样,不能累加**:CodeBuddy 一个 dsh step 内含几十次模型请求,
             * 每条样本的 `prompt_tokens` 都是"整个会话"的 prompt 大小(命中+未命中),
             * 累加会得到几千万 token。而 `contextPressure` 取 `input+cacheRead+cacheWrite`
             * 作上下文占用、`compaction-basic` 又拿 `tokenMeter.measure()` 的
             * `totalTokens >= contextWindow × 0.8` 判定自动压缩——累加值直接顶满
             * 1M 窗口,导致**每条消息都触发一次压缩**(实测踩坑)。
             * 末位采样与原生 provider 语义一致:usage 描述"刚才那次请求"。
             */
            let stepUsage;
            /** 本 step 首个 token 增量(到达时刻 + 原 chunk),供首 token 计时投影。 */
            let firstDelta;
            /** read_image 别名调用的 meta 路径(callId → path,结果落地时写 meta)。 */
            const imageReadPaths = new Map();
            /** 本回合是否见过 agentPhase 心跳(CLI 能力探针;老 CLI 无此信号)。 */
            let agentPhaseSeen = false;
            /** CLI 广播 `session_end`:会话真正空闲(含后台任务/团队收尾)。 */
            let sessionEnded = false;
            /** 最近一次 update 到达时刻(尾巴窗口静默判据)。 */
            let lastUpdateAt = Date.now();
            /** 最近一次**内容** update(文本/思考/工具)到达时刻:识别"续跑"。 */
            let lastContentAt = 0;
            /** 本回合是否起过后台任务(工具参数 run_in_background/background)。 */
            let backgroundLaunched = false;
            /** 尾巴窗口进行中:暂停空闲看门狗(由 phase/session_end/静默/硬顶收尾)。 */
            let tailActive = false;
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
                // 尾巴窗口:CLI 可能长时间静默等后台任务(分钟级),空闲看门狗会误杀;
                // 窗口内改由 phase / session_end / 静默阈值 / 硬顶四者之一收尾。
                if (tailActive)
                    return;
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
            const attachments = this.attachmentsFace();
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
                        ...(stepUsage === undefined ? {} : { usage: stepUsage }),
                        stream: [...accumulator.snapshot()],
                    }, { surfaceOp: 'append' });
                    // 同一块也交给循环组装收尾消息。**必须这样**:dsh 客户端对同一 step 的
                    // assistant/message 末条胜出,而收尾消息由循环从我们 yield 的 chunk 组装;
                    // 只 yield 最后一块的话,长回合里视图就只显示最后一句(实测
                    // "步骤一/已运行"全丢、只剩"步骤三:全部完成")。
                    pendingChunks.push(...piece.closed);
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
             * 把本 step 累计用量交给循环:循环收尾消息(step 最后一条 assistant/message)
             * 由此带上 usage,底部统计栏的 token / 缓存命中、tok/s 才有数。
             */
            const releaseUsage = () => {
                if (stepUsage === undefined)
                    return;
                pendingChunks.push({ type: 'usage', usage: stepUsage });
            };
            /**
             * 落地一次工具调用:先广告(严格校验要求 tool/call 的 name/arguments 与
             * 前置 assistant/message 的 tool-call 块逐字一致),再写 tool/call。
             * @returns tool/call 的事件 seq,未落地时为 undefined。
             */
            const landToolCall = (callId, name, args) => {
                flushPending();
                // 图片文件的 Read → dsh 原生 `read_image`(UI 图片卡片按此名 + result
                // 的 meta.path 渲染缩略图;广告与 call 同名,逐字一致校验不受影响)。
                const alias = imageReadAlias(name, args);
                const dshName = alias?.name ?? name;
                if (alias !== undefined)
                    imageReadPaths.set(callId, alias.path);
                // 后台任务(CLI Bash 后台模式;`npm run dev` 之类长驻进程):尾巴窗口
                // 据此放宽静默阈值——等它跑完的自发续跑(见 AcpTimeouts.tailBgQuietMs)。
                if (/"run_in_background"\s*:\s*true|"background"\s*:\s*true/.test(args))
                    backgroundLaunched = true;
                session.append('assistant/message', {
                    turn,
                    step,
                    message: createAssistantMessage({
                        content: [{ type: 'tool-call', id: ToolCallId(callId), name: dshName, arguments: args }],
                        source: { provider: options.provider ?? 'codebuddy', model },
                    }),
                    ...(stepUsage === undefined ? {} : { usage: stepUsage }),
                    // 首 token 时刻:统计投影只看一个 step 的**第一条** assistant/message
                    // (其后置空 openStep),而工具广告往往就是第一条——带上首个增量的
                    // 真实到达时刻,首 token 延迟才不为空。
                    stream: firstDelta === undefined
                        ? []
                        : [{ type: 'chunk', time: firstDelta.time, chunk: firstDelta.chunk }],
                }, { surfaceOp: 'append' });
                const ev = session.append('tool/call', {
                    turn,
                    step,
                    callId: ToolCallId(callId),
                    name: dshName,
                    arguments: args,
                });
                if (ev !== undefined) {
                    stepState.toolCallSeqs.set(callId, ev.seq);
                    toolsLanded += 1;
                }
                return ev?.seq;
            };
            /** 写一条工具结果(截断 2000 字符;failed/未完成 → isError)。 */
            const landToolResult = async (callId, outputText, isError) => {
                const seq = stepState.toolCallSeqs.get(callId);
                // read_image 别名调用的 presentationMeta(与原生投影同形:{path})。
                const imagePath = imageReadPaths.get(callId);
                imageReadPaths.delete(callId);
                // 图片结果(CodeBuddy 以文本 JSON 交付):落 attachment 转 image 块,
                // 避免整屏 base64 进会话/UI;非图片/失败则保持原文(限长)。
                let content = [{ type: 'text', text: outputText.slice(0, 2000) }];
                if (!isError) {
                    const converted = await toolResultBlocksFromText(attachments, outputText, imagePath);
                    if (converted !== undefined)
                        content = converted;
                }
                session.append('tool/result', {
                    turn,
                    step,
                    message: createToolResultMessage({
                        callId: ToolCallId(callId),
                        content: content,
                        isError,
                    }),
                    ...(imagePath === undefined ? {} : { meta: { path: imagePath } }),
                }, {
                    surfaceOp: 'append',
                    ...(seq !== undefined ? { sourceEventSeqs: [seq] } : {}),
                });
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
                const attachments = this.attachmentsFace();
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
            // 常驻任务表重播:CodeBuddy 的任务列表是**跨回合常驻**的(它自己的 TaskList
            // 里还在),而 dsh 的 `todos` 投影在**每个 turn/start 清空**(设计如此:
            // "standing-plan fold … cleared by the next turn/start")。插件只 CodeBuddy
            // 动任务工具时才写快照,于是新一轮开始后面板必然空着,直到模型再碰任务——
            // 用户视角就是"任务可视化又丢了"(实测:最后 todo/write 14:33:44,之后
            // turn/start 15:07:52 清空,折叠投影 = null)。
            // 回合开头把插件播种(从会话日志重放)的当前快照重写一遍,面板跨回合/跨重启
            // 继续显示同一份计划。
            if (todoState !== undefined) {
                try {
                    if (todoState.snapshot().length > 0)
                        emitTodo();
                }
                catch { /* 展示性桥接不阻断对话 */ }
            }
            /** 处理一条 ACP update:续命 + 会话事件落地 + 流累积。 */
            const handleUpdate = async (update) => {
                // CLI 心跳:agent 阶段 + 会话空闲广播(尾巴窗口的收尾判据)。
                if (update.sessionUpdate === 'session_info_update') {
                    const phase = update._meta?.['codebuddy.ai/agentPhase']?.phase;
                    if (typeof phase === 'string')
                        agentPhaseSeen = true;
                }
                else if (update.sessionUpdate === 'session_end') {
                    sessionEnded = true;
                }
                if (update.sessionUpdate === 'agent_message_chunk' || update.sessionUpdate === 'agent_thought_chunk'
                    || update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
                    lastContentAt = Date.now();
                }
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
                        const delta = { type: 'text-delta', index: currentStream.index, text };
                        if (firstDelta === undefined)
                            firstDelta = { time: Date.now(), chunk: delta };
                        currentStream.chunks.push(delta);
                        return;
                    }
                    case 'usage_update': {
                        // CLI 心跳里的用量:**末位采样**(不是累加,见 stepUsage)。
                        const sample = usageOfUpdate(update);
                        if (sample === undefined)
                            return;
                        stepUsage = sample;
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
                // 当前工作完成后立即处理;插话(`session/steer`)则注入当前运行。
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
                /**
                 * 把一条**插话**(`next-step`,UI 的「立即发送」)转交给运行中的 CodeBuddy:
                 * 走 CLI 的 ACP 扩展 `session/steer`——文本缓冲进**当前运行**的插话
                 * 队列,下一个内部边界注入模型(不打断、不丢消息,实测 1ms 应答、
                 * 原 prompt 正常 end_turn)。
                 *
                 * `session/steer` 不可用(CLI 旧版/运行刚结束返回 `steered:false`)时
                 * 退回排队 prompt——最差等于排队语义,消息不丢。
                 */
                /**
                 * 插话投递成功后的收尾:把这条消息从 dsh 的 `next-step` 队列里摘掉,
                 * 并补一条 `user/message` 落进转写——对齐原生 provider 的插话语义
                 * (点击后立刻离开队列、出现在对话流里)。
                 *
                 * 不这么做的后果(实测):dsh 只在**回合边界**claim 它,而 CodeBuddy
                 * 一轮能跑几十分钟,队列坞会整段显示这条"排队中"的消息——模型其实
                 * 早在运行中读到并处理了(会留下"收到…"之类的回应),但界面没有任何
                 * 已送达的痕迹,用户视角就是"插队没生效"。
                 */
                const settleSteeredInsertion = (insertionId) => {
                    const agents = this.ctx.get('agents');
                    const agent = agents?.get?.(dshSessionId ?? '');
                    const inbox = agent?.inbox;
                    if (inbox?.remove === undefined)
                        return;
                    try {
                        const message = (inbox.nextStep ?? []).find(candidate => String(candidate.id) === insertionId);
                        inbox.remove(insertionId);
                        if (message !== undefined) {
                            // 'user/message' 是核心已知事件;插件依赖的 dsh-session 类型表未含
                            // 该 augmentation,窄化 session 面以落事件(与 todo/write 同法)。
                            const writer = session;
                            writer.append('user/message', message, { surfaceOp: 'append' });
                            steerDebug(`插话收尾:已摘出队列并落 user/message id=${insertionId}`);
                        }
                    }
                    catch (error) {
                        steerDebug(`插话收尾失败(不影响投递): ${String(error).slice(0, 120)}`);
                    }
                };
                const forwardInsertion = (text, insertionId) => {
                    const queuePrompt = () => {
                        steerDebug(`steer 被拒/失败 → 退回排队 prompt: ${JSON.stringify(text.slice(0, 30))}`);
                        sendPrompt([{ type: 'text', text }]);
                        armIdle();
                    };
                    conn.request('session/steer', { sessionId: acpSessionId, contentBlocks: [{ type: 'text', text }] }, 20_000).then(res => {
                        steerDebug(`steer 应答: ${JSON.stringify(res)}`);
                        if (res?.steered !== true) {
                            queuePrompt();
                            return;
                        }
                        settleSteeredInsertion(insertionId);
                    }, error => {
                        steerDebug(`steer 报错: ${String(error).slice(0, 160)}`);
                        queuePrompt();
                    });
                };
                /** 轮询间隔(中途插入检测)。 */
                const steerPollMs = this.options.steerPollMs ?? 1_200;
                let lastSteerPoll = Date.now();
                /** 已记录过"跳过"的 id(诊断日志去重,避免每 1.2s 刷屏)。 */
                const skippedLogged = new Set();
                /**
                 * 插话检测:dsh inbox 里尚未 claim 的 **next-step** 消息 → ACP steer。
                 *
                 * 只处理 next-step(UI 的「立即发送」)。next-turn(排队)在生成中
                 * **不转发**:它由 dsh 在回合收尾 claim 成下一轮输入(排队语义),
                 * 那条路径本来就会把文本补发给 CodeBuddy。若在这里先投一条排队
                 * prompt,用户随后点「立即发送」时消息只是从 next-turn 挪到
                 * next-step(id 不变),markForwarded 会当成"已转发"跳过——插话
                 * 永远发不出去(实测踩坑);不转发则 id 从未被标记,steer 正常发出,
                 * 且不可能重复投递(改走 steer 后由 markForwarded 挡住下一轮补发)。
                 */
                const pollInsertions = () => {
                    if (!direct || dshSessionId === undefined || session === undefined
                        || options.signal?.aborted === true || Date.now() - lastSteerPoll < steerPollMs)
                        return;
                    lastSteerPoll = Date.now();
                    try {
                        for (const insertion of foldPendingInsertions(session.ownEvents?.() ?? [])) {
                            if (!insertion.steer)
                                continue;
                            if (!this.markForwarded(dshSessionId, insertion.id)) {
                                if (!skippedLogged.has(insertion.id)) {
                                    skippedLogged.add(insertion.id);
                                    steerDebug(`poll: 已标记跳过 id=${insertion.id}(已投递过,不重复)`);
                                }
                                continue;
                            }
                            steerDebug(`poll: steer id=${insertion.id} text=${JSON.stringify(insertion.text.slice(0, 30))}`);
                            forwardInsertion(insertion.text, insertion.id);
                        }
                    }
                    catch (error) {
                        steerDebug(`poll 异常: ${String(error)}`);
                    }
                };
                // 尾巴窗口参数(见 AcpTimeouts.tailQuietMs / tailBgQuietMs)。
                const tailQuietMs = to.tailQuietMs ?? 5_000;
                const tailBgQuietMs = to.tailBgQuietMs ?? 10 * 60_000;
                const tailCapMs = to.tailCapMs ?? 30 * 60_000;
                let tailDeadline;
                /**
                 * 尾巴窗口资格:direct(已打开 step)+ 干净 settle + **CLI 支持
                 * agentPhase 心跳**(能力的自然探针)。没有该心跳的老 CLI 无从判断
                 * 空闲,退回旧行为——立即收尾,不加延迟。
                 */
                const tailEligible = () => direct && tailQuietMs > 0 && tailCapMs > 0 && agentPhaseSeen;
                pump: while (true) {
                    while (inFlight > 0 && promptError === undefined && exitError === undefined && !stallTimedOut) {
                        while (queue.length > 0) {
                            const update = queue.shift();
                            if (update !== undefined)
                                await handleUpdate(update);
                        }
                        while (pendingChunks.length > 0)
                            yield pendingChunks.shift();
                        pollInsertions();
                        if (inFlight <= 0 || promptError !== undefined || exitError !== undefined || stallTimedOut)
                            break;
                        await Promise.race([waitForUpdate(), new Promise(resolve => setTimeout(resolve, 100))]);
                    }
                    // settle 与响应同批到达的收尾心跳(phase/session_end/尾巴文本)先落地,
                    // 否则资格判定会看漏它们。
                    while (queue.length > 0) {
                        const update = queue.shift();
                        if (update !== undefined)
                            await handleUpdate(update);
                    }
                    while (pendingChunks.length > 0)
                        yield pendingChunks.shift();
                    // ── 尾巴窗口:end_turn ≠ CLI 空闲 ────────────────────────────────
                    // 后台任务(后台 bash / agent 任务)完成时 CLI **自发续跑**,续跑内容
                    // 以普通 update 推过来。若在 prompt settle 处直接收尾,这些内容没有
                    // 消费者,用户永远等不到模型承诺的"跑完给你最终结果"。所以干净收尾
                    // 后再抽一会儿,收尾判据:
                    //   - 静默 ≥ 预算:普通回合 tailQuietMs;起了后台任务且尚未见续跑
                    //     内容时用 tailBgQuietMs(任务期间 CLI 可以长时间零 update);
                    //   - 或 session_end(CLI 广播:会话真正空闲);
                    //   - 或距 settle 超过 tailCapMs(硬顶);
                    //   - 或 steer 回退成排队 prompt(inFlight 重新 >0)→ 回主泵。
                    if (!tailEligible() || sessionEnded || stallTimedOut || promptError !== undefined
                        || exitError !== undefined || options.signal?.aborted === true
                        || promptResult?.stopReason === 'cancelled' || inFlight > 0) {
                        break pump;
                    }
                    const settledAt = Date.now();
                    tailDeadline ??= settledAt + tailCapMs;
                    tailActive = true;
                    // 进入窗口前拆掉已武装的空闲看门狗(窗口内由静默/硬顶收尾)。
                    if (idleTimer !== undefined) {
                        clearTimeout(idleTimer);
                        idleTimer = undefined;
                    }
                    try {
                        for (;;) {
                            if (sessionEnded || stallTimedOut || promptError !== undefined
                                || exitError !== undefined || options.signal?.aborted)
                                break;
                            while (queue.length > 0) {
                                const update = queue.shift();
                                if (update !== undefined)
                                    await handleUpdate(update);
                            }
                            while (pendingChunks.length > 0)
                                yield pendingChunks.shift();
                            pollInsertions();
                            // steer 被拒退回排队 prompt:又有在途请求,回主泵(尾巴窗口结束)。
                            if (inFlight > 0) {
                                tailActive = false;
                                continue pump;
                            }
                            // 续跑内容出现在普通阈值之后 → 后台任务已回、CLI 在继续干活;
                            // 此后用短阈值(它干完静默即收尾)。
                            const continuationSeen = lastContentAt >= settledAt + tailQuietMs;
                            const budgetMs = backgroundLaunched && !continuationSeen ? tailBgQuietMs : tailQuietMs;
                            if (Date.now() - lastUpdateAt >= budgetMs)
                                break;
                            if (Date.now() >= tailDeadline)
                                break;
                            await Promise.race([waitForUpdate(), new Promise(resolve => setTimeout(resolve, 200))]);
                        }
                    }
                    finally {
                        tailActive = false;
                    }
                    break pump;
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
                    throw new RetryableError(`CodeBuddy ACP 请求失败:${promptError.message}${conn.stderrNote()}`);
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
                    releaseUsage();
                    while (pendingChunks.length > 0)
                        yield pendingChunks.shift();
                    finalizePendingTools();
                    return;
                }
                const stopReason = promptResult?.stopReason;
                const errorMessage = promptResult?.errorMessage;
                flushPending();
                releasePending();
                releaseUsage();
                // stream 模式的收尾块在最后一次泵之后才产生,这里补泵(compaction/标题)。
                while (pendingChunks.length > 0)
                    yield pendingChunks.shift();
                if (errorMessage !== undefined && errorMessage.length > 0) {
                    finalizePendingTools();
                    throw new RetryableError(`CodeBuddy 报错:${errorMessage.slice(0, 300)}${conn.stderrNote()}`);
                }
                // 静默失败防御(实测高频):end_turn 但零思考、零文本、零工具——多为
                // 配额受限/服务端异常导致的静默失败;或只有思考没有产出(半途失败)。
                // 空跑会让主代理以为子代理完成了,用户看到"莫名中断"。
                // 工具落地也算产出:纯工具轮次(无解说文本)是正常形态,误判会触发
                // 自动重试并重复落地事件。
                if (stopReason !== 'cancelled' && (progressSamples === 0 || (textLanded === 0 && toolsLanded === 0))) {
                    finalizePendingTools();
                    throw new RetryableError(`CodeBuddy 静默失败(stopReason: ${stopReason ?? 'none'};`
                        + `${progressSamples} 次进展、0 次文本/工具产出)——可能是配额受限或服务端异常`);
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
