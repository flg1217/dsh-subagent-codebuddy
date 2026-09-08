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
import { AssistantStreamAccumulator, ToolCallId, LlmAdapter, createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm';
import { buildPrompt } from './serialize.js';
import { AcpConnection, DEFAULT_ACP_RUN_TIMEOUTS, isProgressUpdate, toolNameOf } from './acp.js';
/** 续跑兜底:仅当消息里找不到用户输入时使用(resumePrompt 的 fallback)。 */
const CONTINUE_PROMPT = '继续完成之前未完成的任务,持续推进直到任务完全完成或遇到必须用户决策的阻塞——不要每轮只做一小步就停下汇报。基于当前工作区状态继续,不要重复已完成的工作;全部完成后给出最终结果报告。启动 dev server 等长驻进程时必须用 Bash 的 run_in_background: true 参数后台运行——前台运行永不返回会卡死整个任务。';
/** 可重试的委托失败:恢复同一会话续跑(ACP session/load)即可,不重复已完成部分。 */
class RetryableError extends Error {
}
/**
 * 续跑时的增量 prompt。
 *
 * 会话历史已由 CodeBuddy 的会话存储持有(`session/load`),重复整段历史会
 * 浪费上下文并让模型误以为要重做;因此只发最后一条用户消息(续聊的新
 * 输入),没有就退回通用续跑指令。
 */
function resumePrompt(messages) {
    const last = [...messages].reverse().find(message => message.role === 'user');
    if (last === undefined)
        return CONTINUE_PROMPT;
    const text = last.content
        .filter((block) => block.type === 'text')
        .map(block => block.text)
        .join('');
    return text.trim().length > 0 ? text : CONTINUE_PROMPT;
}
/**
 * CodeBuddy 模型适配器。stream() 每次调用:
 * spawn `codebuddy --acp` → initialize → session/new(或 session/load 复用)
 * → session/prompt → 消费 session/update(思考/文本/工具)→ finish 收尾。
 * 每次调用一个 ACP 进程,用完退出;会话连续性由 CodeBuddy 会话存储 +
 * session/load 保证(实测回放完整);静默失败自动恢复会话续跑。
 */
export class CodebuddyLlmAdapter extends LlmAdapter {
    ctx;
    options;
    /**
     * dsh 子代理会话 → CodeBuddy ACP sessionId。
     *
     * 首次调用 `session/new` 建立并记录;之后同一子代理会话的每次 stream 都
     * `session/load` 载入同一会话(官方实现会先回放历史事件,回放不落地)。
     */
    conversationIds = new Map();
    constructor(ctx, options) {
        super();
        this.ctx = ctx;
        this.options = options;
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
        // 会话级 step 状态跨 attempt 连续(重试的续跑是同一子代理任务的延续)。
        const stepState = { stepped: false, toolCallSeqs: new Map() };
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
        // 会话复用:同一子代理会话映射到同一个 CodeBuddy ACP sessionId。
        const dshSessionId = options.sessionId;
        const existing = dshSessionId === undefined ? undefined : this.conversationIds.get(dshSessionId);
        const isResume = existing !== undefined;
        const serialized = isResume
            ? { prompt: resumePrompt(options.messages), cleanup: async () => { } }
            : await buildPrompt(this.ctx, options);
        const { prompt, cleanup } = serialized;
        // 工作目录对齐子代理会话的工作区,保证文件操作发生在正确目录。
        const childSession = options.sessionId !== undefined ? this.ctx.get('sessions')?.get(options.sessionId) : undefined;
        const cwd = childSession?.header.cwd ?? process.cwd();
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
            let maxGapMs = 0;
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
            const armIdle = () => {
                const now = Date.now();
                maxGapMs = Math.max(maxGapMs, now - lastProgressAt);
                lastProgressAt = now;
                progressSamples += 1;
                lastBudgetMs = progressSamples <= to.idleWarmupLines
                    ? to.idleMaxMs
                    : Math.min(Math.max(maxGapMs * to.idleFactor, to.idleMinMs), to.idleMaxMs);
                touch();
            };
            // ── 会话事件落地:turn/step 管理(跨 attempt 连续) ───────────────────
            const session = options.sessionId !== undefined ? this.ctx.get('sessions')?.get(options.sessionId) : undefined;
            const events = session?.ownEvents?.() ?? [];
            const turn = ([...events].reverse().find(e => e.type === 'turn/start')?.data.turn ?? 1);
            let step = ([...events].reverse().find(e => e.type === 'step/start')?.data.step ?? 1);
            let stepOpen = !stepState.stepped;
            const openNextStep = () => {
                step += 1;
                session?.append('step/start', { turn, step });
                stepOpen = true;
            };
            const ensureStep = () => {
                if (session === undefined)
                    return;
                if (!stepState.stepped) {
                    // 首次落地:闭合 agent-loop 的初始 step,再从下一个 step 开始。
                    stepState.stepped = true;
                    closeStep();
                    openNextStep();
                    return;
                }
                if (stepOpen)
                    return;
                openNextStep();
            };
            const closeStep = () => {
                if (!stepOpen || session === undefined)
                    return;
                session.append('step/end', { turn, step });
                stepOpen = false;
            };
            const pendingToolCalls = new Map();
            let pendingBlocks = [];
            let currentStream;
            let nextBlockIndex = 0;
            let lastStreamTime = 0;
            /**
             * 落地已累积的流(块收尾 + assistant/message)。
             * 0.1.3 起 `assistant/chunk` 持久事件已移除:精确模型流以 AssistantStreamRecord[]
             * (AssistantStreamAccumulator 打包)内嵌于 `assistant/message.stream`,live 逐字
             * 由 agent-loop 的 stream 帧通道负责——ACP 场景退化为块级到达,内容无损。
             */
            const flushPending = (interrupted) => {
                if (currentStream === undefined)
                    return;
                const { index, text, chunks, blockType } = currentStream;
                const closed = [...chunks, {
                        type: 'block-end',
                        index,
                        block: blockType === 'text' ? { type: 'text', text } : { type: 'reasoning', text },
                    }];
                currentStream = undefined;
                if (session === undefined)
                    return;
                if (text.length > 0) {
                    ensureStep();
                    const accumulator = new AssistantStreamAccumulator();
                    for (const chunk of closed) {
                        const time = Math.max(Date.now(), lastStreamTime + 1);
                        lastStreamTime = time;
                        accumulator.push({ time, chunk });
                    }
                    pendingBlocks.push(blockType === 'text' ? { type: 'text', text } : { type: 'reasoning', text });
                    session.append('assistant/message', {
                        turn,
                        step,
                        message: createAssistantMessage({
                            content: pendingBlocks,
                            source: { provider: options.provider ?? 'codebuddy', model },
                        }),
                        stream: [...accumulator.snapshot()],
                        ...(interrupted ? { interrupted } : {}),
                    }, { surfaceOp: 'append' });
                    pendingBlocks = [];
                    if (blockType === 'text')
                        textLanded += 1;
                }
            };
            /** 处理一条 ACP update:续命 + 会话事件落地 + 流累积。 */
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
                    case 'tool_call': {
                        if (update.toolCallId === undefined)
                            return;
                        const name = toolNameOf(update);
                        const rawInput = update.rawInput ?? {};
                        // 参数完整性:in_progress 阶段 rawInput 是空壳(参数流式生成中),
                        // 等 pending(toolArgumentsComplete)再落地——否则 UI 只能看到 {}。
                        const complete = update._meta?.['codebuddy.ai/toolArgumentsComplete'] === true
                            || update.status === 'pending';
                        const known = pendingToolCalls.get(update.toolCallId);
                        if (known === undefined) {
                            pendingToolCalls.set(update.toolCallId, { name, rawInput, landed: false });
                            if (!complete)
                                return;
                        }
                        const entry = pendingToolCalls.get(update.toolCallId);
                        if (entry.landed)
                            return;
                        entry.landed = true;
                        entry.rawInput = Object.keys(entry.rawInput).length > 0 ? entry.rawInput : rawInput;
                        flushPending();
                        ensureStep();
                        const ev = session?.append('tool/call', {
                            turn,
                            step,
                            callId: ToolCallId(update.toolCallId),
                            name: entry.name,
                            arguments: JSON.stringify(entry.rawInput),
                        });
                        if (ev !== undefined)
                            stepState.toolCallSeqs.set(update.toolCallId, ev.seq);
                        return;
                    }
                    case 'tool_call_update': {
                        if (update.toolCallId === undefined)
                            return;
                        if (update.status !== 'completed' && update.status !== 'failed')
                            return;
                        let known = pendingToolCalls.get(update.toolCallId);
                        if (known === undefined) {
                            // 兜底:call 事件从未落地(缺 pending 直达 completed 的路径),
                            // 用 update 自带的 rawInput 补落,保证 tool/result 总有配对的 call。
                            known = { name: toolNameOf(update), rawInput: update.rawInput ?? {}, landed: false };
                            pendingToolCalls.set(update.toolCallId, known);
                        }
                        if (!known.landed) {
                            known.landed = true;
                            flushPending();
                            ensureStep();
                            const ev = session?.append('tool/call', {
                                turn,
                                step,
                                callId: ToolCallId(update.toolCallId),
                                name: known.name,
                                arguments: JSON.stringify(known.rawInput),
                            });
                            if (ev !== undefined)
                                stepState.toolCallSeqs.set(update.toolCallId, ev.seq);
                        }
                        pendingToolCalls.delete(update.toolCallId);
                        const outputText = update.rawOutput?.text ?? '';
                        flushPending();
                        const seq = stepState.toolCallSeqs.get(update.toolCallId);
                        session?.append('tool/result', {
                            turn,
                            step,
                            message: createToolResultMessage({
                                callId: ToolCallId(update.toolCallId),
                                content: [{ type: 'text', text: outputText.slice(0, 2000) }],
                                isError: update.status === 'failed',
                            }),
                        }, {
                            surfaceOp: 'append',
                            ...(seq !== undefined ? { sourceEventSeqs: [seq] } : {}),
                        });
                        // 本轮到此结束:闭合 step,下一轮内容在新 step 里落地。
                        closeStep();
                        return;
                    }
                    default:
                        return;
                }
            };
            // ── 建 ACP 进程 + 握手 + 会话 ────────────────────────────────────────
            const conn = new AcpConnection([command, ...prefixArgs, '--acp', '--model', model, '--dangerously-skip-permissions', ...this.options.extraArgs], cwd, onUpdate);
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
                if (isResume && existing !== undefined) {
                    // 历史回放:load 响应前的 update 已被 capturing 丢弃。
                    await conn.request('session/load', { sessionId: existing, cwd, mcpServers: [] });
                    acpSessionId = existing;
                }
                else {
                    const created = await conn.request('session/new', { cwd, mcpServers: [] }, to.firstMs);
                    acpSessionId = created.sessionId;
                    if (dshSessionId !== undefined)
                        this.conversationIds.set(dshSessionId, acpSessionId);
                }
                capturing = false;
                // ── prompt:消费 update 直到响应到达 ────────────────────────────────
                // session/prompt 是长活请求:不设请求超时(传 0),生命周期由动态空闲
                // 超时(cancel → kill → 进程退出 reject)与 abort 保护——固定超时会
                // 误杀长任务(实测 180s 掐死 3 分钟以上的任务)。
                let promptResult;
                let promptError;
                const promptPromise = conn.request('session/prompt', { sessionId: acpSessionId, prompt: [{ type: 'text', text: prompt }] }, 0).then(v => { promptResult = v; }, e => { promptError = e instanceof Error ? e : new Error(String(e)); });
                while (promptResult === undefined && promptError === undefined && exitError === undefined && !stallTimedOut) {
                    while (queue.length > 0) {
                        const update = queue.shift();
                        if (update !== undefined)
                            handleUpdate(update);
                    }
                    if (promptResult !== undefined || promptError !== undefined || exitError !== undefined || stallTimedOut)
                        break;
                    await Promise.race([waitForUpdate(), new Promise(resolve => setTimeout(resolve, 100))]);
                }
                // 抽干尾巴(cancel/exit 后可能还有少量 update)。
                while (queue.length > 0) {
                    const update = queue.shift();
                    if (update !== undefined)
                        handleUpdate(update);
                }
                // 失败分类:可重试的走 RetryableError(外层恢复会话续跑)。
                if (stallTimedOut) {
                    throw new RetryableError(`CodeBuddy ACP 调用超时(已等待 ${Math.round((Date.now() - startedAt) / 1000)}s;`
                        + `静默超过 ${Math.round(lastBudgetMs / 1000)}s 无进展,本次历史最大进展间隔 ${Math.round(maxGapMs / 1000)}s,`
                        + `阈值 = clamp(间隔 × ${to.idleFactor}, ${Math.round(to.idleMinMs / 1000)}s, ${Math.round(to.idleMaxMs / 1000)}s),`
                        + `已收 ${progressSamples} 次进展${conn.stderrNote()})`);
                }
                if (promptError !== undefined)
                    throw new RetryableError(`CodeBuddy ACP 请求失败:${promptError.message}${conn.stderrNote()}`);
                if (exitError !== undefined)
                    throw exitError;
                if (options.signal?.aborted === true) {
                    // 中止:已交付的文本/思考前缀按 0.1.3 语义标 interrupted 落地。
                    flushPending(true);
                    closeStep();
                    return;
                }
                const stopReason = promptResult?.stopReason;
                const errorMessage = promptResult?.errorMessage;
                flushPending();
                closeStep();
                if (errorMessage !== undefined && errorMessage.length > 0) {
                    throw new RetryableError(`CodeBuddy 报错:${errorMessage.slice(0, 300)}${conn.stderrNote()}`);
                }
                // 静默失败防御(实测高频):end_turn 但零思考、零文本、零工具——多为
                // 配额受限/服务端异常导致的静默失败;或只有思考没有产出(半途失败)。
                // 空跑会让主代理以为子代理完成了,用户看到"莫名中断"。
                if (stopReason !== 'cancelled' && (progressSamples === 0 || textLanded === 0)) {
                    throw new RetryableError(`CodeBuddy 静默失败(stopReason: ${stopReason ?? 'none'};`
                        + `${progressSamples} 次进展、0 次文本产出)——可能是配额受限或服务端异常`);
                }
                // end_turn + 有文本产出,或 cancelled:正常收尾。
                yield { type: 'finish', reason: { kind: 'stop' } };
                void stopReason;
            }
            finally {
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
            await cleanup();
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
        });
    }
}
