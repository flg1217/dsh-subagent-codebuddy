/**
 * 回合泵(路线 C1):**一个 CodeBuddy 回合 = 一个 ACP 进程 = 多个 dsh step**。
 *
 * 背景:CodeBuddy 的回合内部是「模型调用 → 工具执行 → 模型调用 …」的循环,
 * 而 dsh 的 step 语义是「一次模型调用 = 一个 step」。旧实现把整个 CodeBuddy
 * 回合塞进一次 provider 调用(=一个巨型 step),文本/工具顺序、每步统计、
 * 分页、客户端 last-wins 渲染全部错位。
 *
 * 本模块把那个内部循环显式化:
 * - **泵**:进程/握手/prompt 只做一次,持续消费 ACP update,按模型调用切段
 *   (segment);
 * - **attach()**:每个 dsh step 调一次,消费当前段;段在「工具调用边界」收尾
 *   时返回,agent-loop 于是写原生 `assistant/message` + `tool/call`,并调用
 *   本模块注册的**回放工具**执行工具调用——回放工具只等 ACP 报来的结果,
 *   由 loop 写原生 `tool/result`;随后 loop 开下一个 step,attach() 消费下一段;
 * - **收尾**:最后一段(无工具调用)在 tail 窗口结束后返回,loop 以
 *   `completed` 闭合回合。
 *
 * 边界识别(实测 cb-segment-probe.mjs):
 * - 工具调用以 `tool_call`(in_progress,参数流式)→ `tool_call`(pending,
 *   `toolArgumentsComplete=true`,全参)出现;`tool_call_update`(completed/failed)
 *   带结果;
 * - 模型调用结束的信号:`agentPhase` → `tool_executing`,或首个工具结果到达,
 *   或静默兜底(老 CLI 无 phase);
 * - `usage_update` 每次模型调用一条,在工具开始执行后 ~100ms 到;收段前给它
 *   一个短宽限期,保证每段带上自己的用量。
 * @module subagent-codebuddy/pump
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { AcpConnection, DEFAULT_ACP_RUN_TIMEOUTS, isProgressUpdate, toolNameOf, usageOfUpdate } from './acp.js';
import { agentIdFromOutput, SubagentMirror } from './mirror.js';
import { foldPendingInsertions } from './inbox.js';
import { todoToolKind } from './todo-bridge.js';
import { imageReadAlias, toolResultBlocksFromText } from './tool-image.js';
/** 仅供测试:清空模块级注册表并释放残留的泵(跨用例隔离)。 */
export function resetPumpStateForTests() {
    for (const pump of livePumps.values())
        pump.dispose();
    livePumps.clear();
    registeredReplayTools.clear();
}
/** 活跃泵:回放工具经此找到当前回合。 */
const livePumps = new Map();
/** 已注册的回放工具(sessionId → 工具名集合;per-agent 注册只需一次)。 */
const registeredReplayTools = new Map();
/** 段收尾后的 usage 宽限期(毫秒):等本次模型调用的用量样本归段。 */
const USAGE_GRACE_MS = 700;
/** 工具边界静默兜底(毫秒):无 phase 信号的老 CLI 用它判定模型调用结束。 */
const BOUNDARY_QUIET_MS = 1_000;
/** 泵心跳间隔(毫秒):steer 轮询 / 看门狗 / 收段判定共用。 */
const TICK_MS = 100;
/**
 * 一个 CodeBuddy 回合的 ACP 泵。生命周期 = 从首次 provider 调用到回合收尾
 * (含 tail 窗口);期间 provider 可被调用多次(每个 dsh step 一次)。
 */
export class TurnPump {
    signal;
    conn;
    acpSessionId = '';
    capturing = true;
    deps;
    to;
    maxAttempts;
    retryDelayMs;
    steerPollMs;
    boundaryQuietMs;
    usageGraceMs;
    stepState;
    attempts = 0;
    /** 段队列:进行中/已完成的模型调用段(attach 顺序消费)。 */
    segments = [];
    calls = new Map();
    /** 本回合是否起过后台任务(工具参数 run_in_background/background)。 */
    backgroundLaunched = false;
    /** 是否产出过文本(静默失败判定:块可能尚未闭合)。 */
    hasText = false;
    finished = false;
    failed;
    disposed = false;
    /** 看门狗状态(与旧直写实现同一套动态预算)。 */
    lastProgressAt = Date.now();
    progressSamples = 0;
    maxGapMs = 0;
    lastBudgetMs;
    stallTimedOut = false;
    killTimer;
    cancelLoopTimer;
    /** 尾巴窗口状态。 */
    promptSettled = false;
    stopReason;
    inFlight = 0;
    promptError;
    agentPhaseSeen = false;
    sessionEnded = false;
    lastUpdateAt = Date.now();
    lastContentAt = 0;
    tailStartAt;
    tailDeadline;
    /** 收段判定辅助。 */
    boundarySeenAt = 0;
    /** 边界/收尾的一次性补判定定时器(心跳粒度不够时的精确收口)。 */
    checkTimer;
    usageGraceUntil = 0;
    toolExecutingSeen = false;
    firstResultSeen = false;
    /** steer 轮询。 */
    lastSteerPoll = 0;
    /** 子代理镜像 / todo 桥。 */
    mirrors = new Map();
    subagentCallIds = new Set();
    tickTimer;
    wake;
    /** 外部 abort(agent-loop 的回合信号)。 */
    onAbort = () => {
        if (this.acpSessionId !== '')
            this.conn?.notify('session/cancel', { sessionId: this.acpSessionId });
        this.cancelLoopTimer ??= setInterval(() => {
            if (this.acpSessionId !== '')
                this.conn?.notify('session/cancel', { sessionId: this.acpSessionId });
        }, 1_000);
        // 消费方(当前 step 的 stream)会自行收尾并释放;但若 abort 落在两次
        // provider 调用之间(上一步已返回、下一步还没开),没有消费方负责释放——
        // 宽限一会儿自行收掉,避免进程/回放工具悬挂到看门狗硬顶。
        const timer = setTimeout(() => this.dispose(), 1_000);
        timer.unref?.();
        this.wakeAll();
    };
    constructor(deps, signal, stepState) {
        this.signal = signal;
        this.deps = deps;
        this.stepState = stepState;
        this.to = { ...DEFAULT_ACP_RUN_TIMEOUTS, ...deps.timeouts };
        this.maxAttempts = deps.maxAttempts ?? 2;
        this.retryDelayMs = deps.retryDelayMs ?? 3_000;
        this.steerPollMs = deps.steerPollMs ?? 1_200;
        this.boundaryQuietMs = this.to.boundaryQuietMs ?? BOUNDARY_QUIET_MS;
        this.usageGraceMs = this.to.usageGraceMs ?? USAGE_GRACE_MS;
        this.lastBudgetMs = this.to.idleMaxMs;
        livePumps.set(deps.dshSessionId, this);
        this.tickTimer = setInterval(() => this.tick(), TICK_MS);
        this.tickTimer.unref?.();
        signal?.addEventListener('abort', this.onAbort, { once: true });
        // 常驻任务表重播:CodeBuddy 任务列表跨回合常驻,dsh 的 todos 投影在每个
        // turn/start 清空——回合开头重写一份当前快照,面板跨回合继续显示同一计划。
        this.replayTodos();
        void this.runAttempt(); // 首段:握手 + prompt
    }
    /** 回放工具 → 当前泵(未在跑/已收尾时为 undefined)。 */
    static forSession(sessionId) {
        return livePumps.get(sessionId);
    }
    /** 回合是否已被调用方中止(abort 交给 loop 的中断语义收尾)。 */
    get aborted() { return this.signal?.aborted === true; }
    // ── 消费面(provider stream)────────────────────────────────────────────
    /**
     * 附加到本回合的下一段:顺序吐出该段的 chunk;段在工具边界或回合收尾处返回。
     * 每个 dsh step 调一次。abort 直接返回(由 loop 的中断语义收尾)。
     */
    async *attach() {
        for (;;) {
            if (this.aborted)
                return;
            const segment = this.segments[0];
            if (segment !== undefined) {
                while (segment.cursor < segment.chunks.length)
                    yield segment.chunks[segment.cursor++];
                if (!segment.closed) {
                    await this.waitEvent();
                    continue;
                }
                this.segments.shift();
                if (this.failed !== undefined)
                    throw this.failed;
                yield {
                    type: 'finish',
                    reason: segment.outcome === 'settle' && this.isMaxTokens() ? { kind: 'max-tokens' } : { kind: 'stop' },
                };
                return;
            }
            if (this.failed !== undefined)
                throw this.failed;
            if (this.finished) {
                yield { type: 'finish', reason: { kind: 'stop' } };
                return;
            }
            await this.waitEvent();
        }
    }
    isMaxTokens() {
        const stop = this.stopReason?.toLowerCase();
        return stop === 'max_tokens' || stop === 'max-tokens';
    }
    // ── 回合生命周期 ───────────────────────────────────────────────────────
    /** 起一次 ACP 进程 + 握手 + prompt(重启路径也走它)。 */
    async runAttempt() {
        if (this.disposed || this.aborted)
            return;
        this.attempts += 1;
        this.capturing = true;
        this.promptSettled = false;
        this.stopReason = undefined;
        this.promptError = undefined;
        this.toolExecutingSeen = false;
        this.firstResultSeen = false;
        this.boundarySeenAt = 0;
        this.usageGraceUntil = 0;
        this.sessionEnded = false;
        this.tailStartAt = undefined;
        this.tailDeadline = undefined;
        // 参数与旧实现逐字一致(实测过的组合):`--dangerously-skip-permissions`
        // 而非 `--permission-mode`——后者虽是配置项,但从未在此路径生效,不顺手改
        // 行为(改权限参数等于换一套 CLI 行为,需要单独实测)。
        const argv = [
            this.deps.command,
            ...this.deps.prefixArgs,
            '--acp',
            '--model',
            this.deps.model,
            ...this.deps.reasoningEffort === undefined ? [] : ['--effort', this.deps.reasoningEffort],
            '--dangerously-skip-permissions',
            ...this.deps.extraArgs,
        ];
        const conn = new AcpConnection(argv, this.deps.cwd, update => this.onUpdate(update));
        this.conn = conn;
        conn.onExit(info => {
            if (conn.wasKilled || this.stallTimedOut || this.disposed)
                return;
            this.failRun(new Error(`CodeBuddy ACP 进程退出(code ${info.code ?? 'null'}${info.signal !== null ? `,signal ${info.signal}` : ''})${conn.stderrNote()}`));
        });
        try {
            await conn.request('initialize', {
                protocolVersion: 1,
                clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
            }, this.to.firstMs);
            if (this.deps.resume !== undefined) {
                try {
                    await conn.request('session/load', { sessionId: this.deps.resume.acpId, cwd: this.deps.acpCwd, mcpServers: [] });
                    this.acpSessionId = this.deps.resume.acpId;
                }
                catch {
                    // CodeBuddy 侧会话存储丢失:回退新会话 + 完整历史重发。
                    this.deps.forgetConversation();
                    this.deps.resume = undefined;
                    const full = await this.deps.fallbackPrompt();
                    this.deps.prompt = full.prompt;
                    this.deps.images = full.images;
                    const created = await conn.request('session/new', { cwd: this.deps.acpCwd, mcpServers: [] }, this.to.firstMs);
                    this.acpSessionId = created.sessionId;
                }
            }
            else {
                const created = await conn.request('session/new', { cwd: this.deps.acpCwd, mcpServers: [] }, this.to.firstMs);
                this.acpSessionId = created.sessionId;
            }
            this.deps.rememberConversation(this.acpSessionId, this.deps.sentCount);
            this.capturing = false;
            this.sendPrompt(this.deps.prompt, this.deps.images);
            this.armProgress();
        }
        catch (error) {
            if (this.aborted || this.disposed)
                return;
            this.failRun(error instanceof Error ? error : new Error(String(error)));
        }
    }
    sendPrompt(prompt, images) {
        const conn = this.conn;
        if (conn === undefined)
            return;
        this.inFlight += 1;
        this.promptSettled = false;
        void conn.request('session/prompt', {
            sessionId: this.acpSessionId,
            prompt: [
                { type: 'text', text: prompt },
                ...images.map(image => ({ type: 'image', data: image.data, mimeType: image.mimeType })),
            ],
        }, 0).then(value => {
            this.stopReason = value.stopReason;
            if (value.errorMessage !== undefined && value.errorMessage.length > 0) {
                this.promptError = new Error(value.errorMessage);
            }
        }, error => {
            this.promptError = error instanceof Error ? error : new Error(String(error));
        }).finally(() => {
            this.inFlight -= 1;
            if (this.promptError === undefined)
                this.promptSettled = true;
            this.wakeAll();
        });
    }
    /** 回合收尾:断开进程、清空活跃表、唤醒所有等待者。 */
    finishTurn() {
        if (this.finished)
            return;
        this.finished = true;
        // 只摘自己:上一回合的泵迟到收尾时,同 id 的新回合泵可能已经登记。
        if (livePumps.get(this.deps.dshSessionId) === this)
            livePumps.delete(this.deps.dshSessionId);
        this.dispose();
    }
    /** 失败:首段无产出 → 重启;否则整体失败(消费方抛出,loop 收错误回合)。 */
    failRun(error) {
        if (this.finished || this.disposed)
            return;
        if (this.canRestart()) {
            this.restart(error);
            return;
        }
        this.failed = error;
        for (const segment of this.segments) {
            if (!segment.closed) {
                this.closeOpenBlock(segment);
                segment.closed = true;
            }
        }
        for (const call of this.calls.values()) {
            for (const waiter of call.waiting.splice(0))
                waiter.reject(error);
        }
        this.finishTurn();
        this.wakeAll();
    }
    /** 重启资格:仍是首段、本回合无任何产出、还有重试次数。 */
    canRestart() {
        return this.attempts < this.maxAttempts
            && !this.hasText
            && this.calls.size === 0
            && !this.aborted;
    }
    restart(error) {
        this.disposeProcess();
        this.capturing = true;
        // 已登记的 CodeBuddy 会话继续复用之(避免重试丢历史)。
        if (this.acpSessionId !== '')
            this.deps.resume = { acpId: this.acpSessionId };
        this.acpSessionId = '';
        this.promptError = undefined;
        this.stallTimedOut = false;
        this.lastProgressAt = Date.now();
        this.segments = [];
        this.backgroundLaunched = false;
        const timer = setTimeout(() => { void this.runAttempt(); }, this.retryDelayMs);
        timer.unref?.();
        this.wakeAll();
        void error;
    }
    /** 补一次「到期即判定」的定时器(收段宽限/尾巴静默预算)。 */
    armCheck(delayMs) {
        if (this.checkTimer !== undefined)
            clearTimeout(this.checkTimer);
        const timer = setTimeout(() => {
            this.checkTimer = undefined;
            this.tick();
        }, Math.max(5, delayMs));
        timer.unref?.();
        this.checkTimer = timer;
    }
    /** 释放进程与计时器(幂等;不改变 finished 状态)。 */
    disposeProcess() {
        if (this.checkTimer !== undefined) {
            clearTimeout(this.checkTimer);
            this.checkTimer = undefined;
        }
        if (this.killTimer !== undefined) {
            clearTimeout(this.killTimer);
            this.killTimer = undefined;
        }
        if (this.cancelLoopTimer !== undefined) {
            clearInterval(this.cancelLoopTimer);
            this.cancelLoopTimer = undefined;
        }
        try {
            this.conn?.kill();
        }
        catch { /* 已退出 */ }
        this.conn = undefined;
    }
    /** 整体收尾:释放一切,唤醒等待者。 */
    dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        // 摘掉自己的登记:否则已释放的泵会遮蔽同会话下一回合的新泵。
        if (livePumps.get(this.deps.dshSessionId) === this)
            livePumps.delete(this.deps.dshSessionId);
        clearInterval(this.tickTimer);
        this.signal?.removeEventListener('abort', this.onAbort);
        // 未完成的工具调用:拒绝所有等待者,避免回放工具悬挂。
        for (const call of this.calls.values()) {
            for (const waiter of call.waiting.splice(0))
                waiter.reject(new Error('CodeBuddy 回合已结束'));
        }
        for (const mirror of this.mirrors.values())
            void mirror.finish();
        this.mirrors.clear();
        this.disposeProcess();
        this.wakeAll();
    }
    // ── 回放工具 ───────────────────────────────────────────────────────────
    /**
     * 等一次工具调用的结果(回放工具的 execute 调用面)。
     * 结果文本截断 2000 字符(与旧直写路径一致);图片结果转 attachment 内容块,
     * 避免 base64 进会话。
     */
    async awaitResult(callId, signal) {
        const call = this.calls.get(callId);
        if (call === undefined)
            throw new Error(`CodeBuddy: 未知的工具调用 ${callId}(该调用不属于当前回合)`);
        const outcome = call.outcome ?? await new Promise((resolve, reject) => {
            call.waiting.push({ resolve, reject });
            signal?.addEventListener('abort', () => {
                const index = call.waiting.findIndex(waiter => waiter.resolve === resolve);
                if (index >= 0)
                    call.waiting.splice(index, 1);
                reject(new Error('tool call aborted'));
            }, { once: true });
        });
        if (outcome.isError)
            throw new Error(outcome.text.slice(0, 2000));
        let blocks = [{ type: 'text', text: outcome.text.slice(0, 2000) }];
        const converted = await toolResultBlocksFromText(this.deps.attachmentsOf(), outcome.text, call.imagePath);
        if (converted !== undefined)
            blocks = converted;
        return { blocks, ...(call.imagePath === undefined ? {} : { meta: { path: call.imagePath } }) };
    }
    /** 为此 agent 注册一个回放工具(同名工具名只注册一次)。 */
    ensureReplayTool(name) {
        const sessionId = this.deps.dshSessionId;
        let names = registeredReplayTools.get(sessionId);
        if (names === undefined) {
            names = new Set();
            registeredReplayTools.set(sessionId, names);
        }
        if (names.has(name))
            return;
        names.add(name);
        try {
            const agents = this.deps.ctx.get?.('agents');
            const agent = agents?.get?.(sessionId);
            const tools = agent?.ctx?.get?.('tools');
            if (tools?.register === undefined)
                return;
            tools.register(defineTool({
                name,
                description: `“${name}” was executed by the CodeBuddy CLI on this session; this tool records`
                    + ' the CLI-reported outcome back into the conversation.',
                parameters: {},
                output: {
                    // 值 = { blocks: ContentBlock[], meta?: JSON }:内容由 CLI 输出转换而来,
                    // 形态不由 dsh 约束(不透明重放),用 json 逃生口。
                    schema: { type: 'json' },
                    render: (_args, value) => value.blocks,
                    presentationMeta: (_args, value) => value.meta,
                },
                isConcurrencySafe: () => true,
                execute: async (_args, exec) => {
                    const pump = TurnPump.forSession(sessionId);
                    if (pump === undefined) {
                        throw new Error('CodeBuddy: 该会话当前没有运行中的 CodeBuddy 回合(模型可能已切换)');
                    }
                    return await pump.awaitResult(exec.callId, exec.signal);
                },
            }));
        }
        catch { /* 重复注册/服务缺失:不影响对话 */ }
    }
    // ── update 处理(同步状态机)────────────────────────────────────────────
    onUpdate(update) {
        if (this.capturing || this.disposed)
            return;
        this.applyUpdate(update);
        // 事件驱动的收段判定:边界信号(phase=tool_executing / 工具结果)一到就
        // 收口,不等心跳——否则下一段内容可能漏进上一段(实测:慢心跳 + 快速续跑)。
        this.checkSegmentBoundary();
    }
    /** 单条 update 的状态机(不触发收段判定)。 */
    applyUpdate(update) {
        this.lastUpdateAt = Date.now();
        const kind = update.sessionUpdate;
        if (kind === 'session_info_update') {
            const phase = update._meta?.['codebuddy.ai/agentPhase']?.phase;
            if (typeof phase === 'string') {
                this.agentPhaseSeen = true;
                if (phase === 'tool_executing')
                    this.toolExecutingSeen = true;
            }
        }
        else if (kind === 'session_end') {
            this.sessionEnded = true;
        }
        if (isProgressUpdate(update)) {
            this.lastContentAt = Date.now();
            this.armProgress();
        }
        switch (kind) {
            case 'agent_thought_chunk':
            case 'agent_message_chunk': {
                const text = update.content?.text ?? '';
                if (text.length === 0)
                    return;
                const blockKind = kind === 'agent_thought_chunk' ? 'reasoning' : 'text';
                const messageId = update.messageId ?? `${blockKind}-anonymous`;
                const segment = this.openSegment();
                if (segment.open === undefined || segment.open.kind !== blockKind || segment.open.messageId !== messageId) {
                    this.closeOpenBlock(segment);
                    const index = segment.blockIndex++;
                    segment.open = { kind: blockKind, index, messageId, text: '' };
                    segment.chunks.push({ type: 'block-start', index, blockType: blockKind });
                }
                if (blockKind === 'text')
                    this.hasText = true;
                segment.open.text += text;
                segment.chunks.push({
                    type: blockKind === 'reasoning' ? 'reasoning-delta' : 'text-delta',
                    index: segment.open.index,
                    text,
                });
                this.wakeAll();
                return;
            }
            case 'usage_update': {
                const sample = usageOfUpdate(update);
                if (sample === undefined)
                    return;
                // 归段:当前未收尾的段(收段前等 usage 的宽限期依赖它);样本同时作为
                // chunk 交给 loop,统计/上下文占用才有数(assembler 取流内末位样本)。
                const segment = this.openSegment();
                segment.usage = sample;
                segment.chunks.push({ type: 'usage', usage: sample });
                this.wakeAll();
                return;
            }
            case 'tool_call': {
                if (update.toolCallId === undefined)
                    return;
                if (update._meta?.['codebuddy.ai/isSubagent'] === true)
                    this.subagentCallIds.add(update.toolCallId);
                const complete = update._meta?.['codebuddy.ai/toolArgumentsComplete'] === true || update.status === 'pending';
                const known = this.calls.get(update.toolCallId);
                if (known === undefined) {
                    if (!complete) {
                        // 参数流式生成中:先登记名字,等完整形态再发射。
                        this.calls.set(update.toolCallId, {
                            id: update.toolCallId,
                            rawName: toolNameOf(update),
                            dshName: toolNameOf(update),
                            argsJson: JSON.stringify(update.rawInput ?? {}),
                            announced: false,
                            waiting: [],
                        });
                        return;
                    }
                    this.announceCall(update.toolCallId, toolNameOf(update), update.rawInput ?? {});
                    return;
                }
                if (!known.announced && complete) {
                    const rawInput = Object.keys(update.rawInput ?? {}).length > 0 ? update.rawInput : {};
                    this.announceCall(update.toolCallId, toolNameOf(update), rawInput);
                }
                return;
            }
            case 'tool_call_update': {
                if (update.toolCallId === undefined)
                    return;
                if (update.status !== 'completed' && update.status !== 'failed')
                    return;
                if (update._meta?.['codebuddy.ai/isSubagent'] === true)
                    this.subagentCallIds.add(update.toolCallId);
                let known = this.calls.get(update.toolCallId);
                if (known === undefined) {
                    // 兜底:缺 pending 直达 completed 的路径,用 update 自带 rawInput 补发。
                    const rawInput = Object.keys(update.rawInput ?? {}).length > 0 ? update.rawInput : {};
                    this.announceCall(update.toolCallId, toolNameOf(update), rawInput);
                    known = this.calls.get(update.toolCallId);
                }
                if (!known.announced)
                    this.announceCall(update.toolCallId, known.rawName, {});
                this.firstResultSeen = true;
                const outcome = { text: update.rawOutput?.text ?? '', isError: update.status === 'failed' };
                known.outcome = outcome;
                for (const waiter of known.waiting.splice(0))
                    waiter.resolve(outcome);
                this.confirmTodo(update.toolCallId, known.rawName, outcome.text);
                this.finishMirror(update.toolCallId, outcome.text);
                this.wakeAll();
                return;
            }
            default:
                return;
        }
    }
    /** 参数完整的工具调用:注册回放工具 → 段内发射 tool-call 块。 */
    announceCall(callId, rawName, rawInput) {
        const argsJson = JSON.stringify(rawInput);
        const alias = imageReadAlias(rawName, argsJson);
        const dshName = alias?.name ?? rawName;
        const existing = this.calls.get(callId);
        if (existing?.announced === true)
            return;
        this.calls.set(callId, {
            id: callId,
            rawName,
            dshName,
            argsJson,
            announced: true,
            ...(alias === undefined ? {} : { imagePath: alias.path }),
            waiting: existing?.waiting ?? [],
            ...(existing?.outcome === undefined ? {} : { outcome: existing.outcome }),
        });
        if (/"run_in_background"\s*:\s*true|"background"\s*:\s*true/.test(argsJson))
            this.backgroundLaunched = true;
        this.ensureReplayTool(dshName);
        const segment = this.openSegment();
        this.closeOpenBlock(segment);
        const index = segment.blockIndex++;
        segment.calls.push(callId);
        segment.chunks.push({
            type: 'block-end',
            index,
            block: { type: 'tool-call', id: ToolCallId(callId), name: dshName, arguments: argsJson },
        });
        this.landTodo(callId, rawName, rawInput);
        this.maybeStartMirror(callId, rawInput);
        this.wakeAll();
    }
    /** 取(或建)当前打开的段。 */
    openSegment() {
        const last = this.segments[this.segments.length - 1];
        if (last !== undefined && !last.closed)
            return last;
        const segment = { chunks: [], cursor: 0, calls: [], closed: false, outcome: 'settle', blockIndex: 0 };
        this.segments.push(segment);
        return segment;
    }
    closeOpenBlock(segment) {
        const open = segment.open;
        if (open === undefined)
            return;
        segment.open = undefined;
        if (open.text.length === 0)
            return;
        if (open.kind === 'text')
            this.hasText = true;
        segment.chunks.push({
            type: 'block-end',
            index: open.index,
            block: open.kind === 'text' ? { type: 'text', text: open.text } : { type: 'reasoning', text: open.text },
        });
    }
    closeSegment(segment, outcome) {
        if (segment.closed)
            return;
        this.closeOpenBlock(segment);
        segment.closed = true;
        segment.outcome = outcome;
        this.boundarySeenAt = 0;
        this.usageGraceUntil = 0;
        this.toolExecutingSeen = false;
        this.firstResultSeen = false;
        this.wakeAll();
    }
    /** 心跳:steer 轮询 → 看门狗 → 收段判定 → tail 收尾。 */
    tick() {
        if (this.disposed || this.finished)
            return;
        this.pollInsertions();
        this.checkStall();
        if (this.disposed || this.finished)
            return;
        this.checkSegmentBoundary();
        this.checkTail();
    }
    /** 收段判定:工具边界。 */
    checkSegmentBoundary() {
        const segment = this.segments[this.segments.length - 1];
        if (segment === undefined || segment.closed || segment.calls.length === 0)
            return;
        const now = Date.now();
        // 模型调用结束的三种信号:phase=tool_executing / 首个工具结果 / 静默兜底。
        if (this.boundarySeenAt === 0) {
            const boundary = this.toolExecutingSeen
                || this.firstResultSeen
                || now - this.lastProgressAt > this.boundaryQuietMs;
            if (!boundary)
                return;
            this.boundarySeenAt = now;
            // 用量样本可能晚到 ~100ms;给它一个短宽限期,让本段带上自己的用量。
            this.usageGraceUntil = segment.usage === undefined ? now + this.usageGraceMs : 0;
            this.armCheck(this.usageGraceUntil - now + 5);
            return;
        }
        if (segment.usage === undefined && this.usageGraceUntil > 0 && now < this.usageGraceUntil)
            return;
        this.closeSegment(segment, 'tools');
    }
    /** tail 窗口:prompt 干净收尾后继续抽流(后台任务会自发续跑)。 */
    checkTail() {
        if (this.promptError !== undefined) {
            this.failRun(this.promptError);
            return;
        }
        if (!this.promptSettled || this.inFlight > 0 || this.aborted)
            return;
        // 静默失败:end_turn 但零文本零工具(配额/服务端异常)——首段重启,否则报错。
        if (this.progressSamples === 0 || (!this.hasText && this.calls.size === 0)) {
            this.failRun(new Error(`CodeBuddy 静默失败(stopReason: ${this.stopReason ?? 'none'};`
                + `${this.progressSamples} 次进展、0 次文本/工具产出)——可能是配额受限或服务端异常`));
            return;
        }
        const segment = this.segments[this.segments.length - 1];
        if (segment === undefined || segment.closed) {
            this.finishTurn();
            return;
        }
        const tailQuietMs = this.to.tailQuietMs ?? 5_000;
        const tailBgQuietMs = this.to.tailBgQuietMs ?? 600_000;
        const tailCapMs = this.to.tailCapMs ?? 1_800_000;
        // 老 CLI 无 agentPhase 心跳:无从判断空闲,立即收尾(与旧行为一致)。
        if (!this.agentPhaseSeen || tailQuietMs <= 0 || tailCapMs <= 0 || this.sessionEnded) {
            this.closeSegment(segment, 'settle');
            this.finishTurn();
            return;
        }
        const now = Date.now();
        this.tailStartAt ??= now;
        this.tailDeadline ??= this.tailStartAt + tailCapMs;
        // 起了后台任务且尚未见续跑内容:放宽到 tailBgQuietMs(任务期间 CLI 可以
        // 长时间零 update);续跑内容一出现即回到短阈值。
        const continuationSeen = this.lastContentAt >= this.tailStartAt + tailQuietMs;
        const budgetMs = this.backgroundLaunched && !continuationSeen ? tailBgQuietMs : tailQuietMs;
        if (now - this.lastUpdateAt >= budgetMs || now >= this.tailDeadline) {
            this.closeSegment(segment, 'settle');
            this.finishTurn();
            return;
        }
        this.armCheck(Math.min(this.lastUpdateAt + budgetMs, this.tailDeadline) - now + 5);
    }
    /** 动态空闲看门狗:进展性事件续命;在途工具/等结果期间只保留硬顶。 */
    checkStall() {
        if (this.stallTimedOut || this.disposed)
            return;
        const idleFor = Date.now() - this.lastProgressAt;
        const pendingTools = [...this.calls.values()].some(call => call.announced && call.outcome === undefined);
        if (pendingTools) {
            // 在途工具(长工具分钟级无心跳)期间主逻辑暂停计时,这里只设硬顶兜底。
            const cap = this.to.guardCapMs ?? 1_800_000;
            if (cap > 0 && idleFor > cap)
                this.stall();
            return;
        }
        if (this.tailStartAt !== undefined)
            return; // tail 窗口内由静默阈值/硬顶收尾
        if (idleFor > this.lastBudgetMs)
            this.stall();
    }
    stall() {
        this.stallTimedOut = true;
        if (this.acpSessionId !== '')
            this.conn?.notify('session/cancel', { sessionId: this.acpSessionId });
        if (this.killTimer === undefined) {
            const timer = setTimeout(() => { try {
                this.conn?.kill();
            }
            catch { /* 已退出 */ } }, 5_000);
            timer.unref?.();
            this.killTimer = timer;
        }
        this.failRun(new Error('CodeBuddy ACP 调用超时(静默超过'
            + ` ${Math.round(this.lastBudgetMs / 1000)}s 无进展,本回合最大进展间隔 ${Math.round(this.maxGapMs / 1000)}s)`
            + `${this.conn?.stderrNote() ?? ''}`));
    }
    armProgress() {
        const now = Date.now();
        this.maxGapMs = Math.max(this.maxGapMs, now - this.lastProgressAt);
        this.stepState.maxGapMs = this.maxGapMs;
        this.lastProgressAt = now;
        this.progressSamples += 1;
        this.lastBudgetMs = this.progressSamples <= this.to.idleWarmupLines
            ? this.to.idleMaxMs
            : Math.min(Math.max(this.maxGapMs * this.to.idleFactor, this.to.idleMinMs), this.to.idleMaxMs);
    }
    // ── steer 轮询 / todo / 镜像 ───────────────────────────────────────────
    /**
     * 未 claim 的 next-step 插话 → ACP `session/steer`(下一个内部边界注入)。
     *
     * C1 下 loop 会在**下一个模型调用边界**claim 这条消息并原生写 `user/message`
     * ——插话的队列停留不再是一整轮(旧实现的巨型 step 才需要手工摘队列)。
     */
    pollInsertions() {
        const now = Date.now();
        if (now - this.lastSteerPoll < this.steerPollMs)
            return;
        this.lastSteerPoll = now;
        if (this.aborted || this.acpSessionId === '' || this.conn === undefined)
            return;
        try {
            for (const insertion of foldPendingInsertions(this.deps.session?.ownEvents?.() ?? [])) {
                if (!insertion.steer)
                    continue;
                if (!this.deps.markForwarded(insertion.id))
                    continue;
                const conn = this.conn;
                if (conn === undefined)
                    return;
                const queuePrompt = () => { this.sendPrompt(insertion.text, []); };
                void conn.request('session/steer', { sessionId: this.acpSessionId, contentBlocks: [{ type: 'text', text: insertion.text }] }, 20_000).then(result => { if (result?.steered !== true)
                    queuePrompt(); }, () => queuePrompt());
            }
        }
        catch { /* 插话轮询失败不影响主流程 */ }
    }
    replayTodos() {
        try {
            const state = this.deps.todoStateOf();
            if (state !== undefined && state.snapshot().length > 0)
                this.emitTodo(state);
        }
        catch { /* 展示性桥接不阻断对话 */ }
    }
    emitTodo(state) {
        try {
            this.deps.session?.append?.('todo/write', { todos: state.snapshot() });
        }
        catch { /* 展示性桥接不阻断对话 */ }
    }
    landTodo(callId, name, rawInput) {
        const state = this.deps.todoStateOf();
        if (state === undefined)
            return;
        const kind = todoToolKind(name);
        if (kind === undefined)
            return;
        try {
            if (kind === 'taskupdate') {
                state.deferTaskUpdate(callId, rawInput);
                return;
            }
            if (state.applyToolCall(name, rawInput))
                this.emitTodo(state);
        }
        catch { /* 展示性桥接不阻断对话 */ }
    }
    confirmTodo(callId, name, text) {
        const state = this.deps.todoStateOf();
        if (state === undefined || todoToolKind(name) === undefined)
            return;
        try {
            state.applyToolResult(name, text);
            if (state.resolveTaskUpdate(callId, text))
                this.emitTodo(state);
        }
        catch { /* 展示性桥接不阻断对话 */ }
    }
    maybeStartMirror(callId, rawInput) {
        if (!this.subagentCallIds.has(callId) || this.mirrors.has(callId))
            return;
        if (this.stepState.mirroredCalls.has(callId))
            return;
        if (this.acpSessionId === '')
            return;
        const sessions = this.deps.ctx.get?.('sessions');
        if (sessions?.create === undefined)
            return;
        const description = rawInput['description'];
        const prompt = rawInput['prompt'];
        const attachments = this.deps.attachmentsOf();
        const mirror = new SubagentMirror({
            sessions: sessions,
            parentSessionId: this.deps.dshSessionId,
            cwd: this.deps.cwd,
            acpSessionId: this.acpSessionId,
            ...(this.deps.nativeBaseDir !== undefined ? { projectsRoot: this.deps.nativeBaseDir } : {}),
            ...(this.deps.childSession?.header?.agentPreset === undefined
                ? {}
                : { agentPreset: this.deps.childSession.header.agentPreset }),
            ...(attachments === undefined
                ? {}
                : { attachments: { saveImage: (data, mediaType) => attachments.saveImage({ data, mediaType }) } }),
        });
        mirror.start({
            label: typeof description === 'string' && description.length > 0 ? description : 'CodeBuddy 子代理',
            prompt: typeof prompt === 'string' ? prompt : '',
            delegationDepth: (this.deps.childSession?.header?.delegationDepth ?? 0) + 1,
        });
        this.mirrors.set(callId, mirror);
        this.stepState.mirroredCalls.add(callId);
    }
    finishMirror(callId, outputText) {
        const mirror = this.mirrors.get(callId);
        if (mirror === undefined)
            return;
        void mirror.finish(agentIdFromOutput(outputText));
        this.mirrors.delete(callId);
    }
    // ── 唤醒机制 ───────────────────────────────────────────────────────────
    waitEvent() {
        return new Promise(resolve => { this.wake = resolve; });
    }
    wakeAll() {
        const wake = this.wake;
        this.wake = undefined;
        wake?.();
    }
}
