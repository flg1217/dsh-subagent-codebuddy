/**
 * `/compact` 的 CodeBuddy 转发(per-agent 命令覆盖)。
 *
 * 该模式下数据源在 CLI:CLI 会话持有真实上下文(dsh 侧只是渲染层与消息日志),
 * 所以"压缩"必须发给 CLI 压它自己的历史——而不是让 dsh 压缩 dsh 侧的消息。
 * 实测反例:dsh 的压缩测量以 CLI 的 usage 为基线(835K),而压缩对象是 dsh 侧
 * 残余消息(3.4K),压不动 → 压力不降 → 每个 step 循环触发、历史被反复摘要。
 *
 * dsh 的命令系统支持 per-agent 覆盖(同名冲突的报错原文:"for a per-agent
 * variant, mount a command-injected plugin under that agent's `agent.ctx`"),
 * 插件在 `agent/created` 时于 `agent.ctx` 注册 `compact`:
 * - codebuddy 会话 → 进 agent 的 **maintenance 相位**后转发 `/compact` 给 CLI
 *   (`/compact` 是 CLI 的 user-command,压它自己的会话历史);
 * - 其它会话 → 回落到 dsh 自己的 `ctx.compaction.compactNow`,行为不变。
 *
 * **maintenance 相位是必须的**(2026-09-13 实测):不占住 agent 时,用户在压缩
 * 期间发的消息会立刻开新回合抢跑——新回合的请求会和压缩并发写同一个 CLI
 * 会话,把压缩结果盖掉(实测:压缩期间开了一轮 turn,该轮之后 prompt 反而从
 * 594K 涨到 614K→683K,压缩等于白做)。进 maintenance 后消息按原生行为
 * 排队(latch 到压缩结束再跑),与 dsh 原生 `compactNow` 语义一致。
 *
 * 压缩本身是有效的:干净执行的两次转发(20:14、22:38)让下一轮 prompt
 * 从 349K→46K、463K→64K。
 * @module subagent-codebuddy/compact-command
 */
import { AcpConnection, DEFAULT_ACP_RUN_TIMEOUTS, cliToolPolicyArgs, usageOfUpdate } from './acp.js';
import { TurnPump } from './pump.js';
/** 转发 `/compact` 的等待上限(压缩可能很久,给足 15 分钟)。 */
const COMPACT_TIMEOUT_MS = 15 * 60_000;
/**
 * 把一条 `/compact` 转发给该会话的 CLI(短连接 resume + 用户命令 prompt)。
 * @param deps - 挂载依赖(命令/参数/会话映射)。
 * @param sessionId - dsh 会话 id(经映射找到 CLI 会话)。
 * @param cwd - CLI 工作目录。
 * @param signal - 命令取消信号。
 * @returns 命令结果。
 */
export async function forwardCompactToCli(deps, sessionId, cwd, signal) {
    const record = deps.conversations.get(sessionId);
    if (record === undefined) {
        return { kind: 'error', text: '这个会话还没有 CodeBuddy CLI 会话(先发一条消息,再压缩)。' };
    }
    // 回合进行中不开第二条 CLI 连接:同一 ACP 会话被并发操作可能互相冲突
    // (主回合泵正持有该会话)。自动压缩路径拿到 error 会回落内置压缩。
    const busy = deps.isSessionBusy?.(sessionId) ?? (TurnPump.forSession(sessionId) !== undefined);
    if (busy) {
        return { kind: 'error', text: '会话的回合正在运行中:等它结束后再压缩(避免与 CLI 的连接冲突)。' };
    }
    const argv = [
        deps.command,
        ...deps.prefixArgs,
        '--acp',
        '--model',
        deps.modelOf(),
        '--dangerously-skip-permissions',
        ...cliToolPolicyArgs(),
        ...deps.extraArgs,
    ];
    // 压缩过程中的用量样本:CLI 的压缩 agent 会把整段历史读进去摘要,它的
    // prompt_tokens 就是"压缩前上下文大小"——回给用户一个可核对的数字。
    let contextBefore;
    const onUpdate = (update) => {
        const sample = usageOfUpdate(update);
        if (sample === undefined)
            return;
        const tokens = sample.inputTokens + (sample.cacheReadTokens ?? 0);
        if (tokens > 0 && (contextBefore === undefined || tokens > contextBefore))
            contextBefore = tokens;
    };
    const conn = new AcpConnection(argv, cwd, onUpdate);
    const to = DEFAULT_ACP_RUN_TIMEOUTS;
    try {
        await conn.request('initialize', {
            protocolVersion: 1,
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        }, to.firstMs);
        await conn.request('session/load', { sessionId: record.acpId, cwd, mcpServers: [] }, to.firstMs);
        if (signal.aborted)
            return { kind: 'error', text: '压缩已取消。' };
        // `/compact` 是 CLI 的用户命令(user-command,非模型消息):CLI 压它自己的历史。
        await conn.request('session/prompt', {
            sessionId: record.acpId,
            prompt: [{ type: 'text', text: '/compact' }],
        }, COMPACT_TIMEOUT_MS);
        const before = contextBefore === undefined
            ? ''
            : `压缩前上下文 ≈ ${Math.round(contextBefore / 1000)}K tokens;`;
        return {
            kind: 'success',
            text: `已让 CodeBuddy CLI 压缩其会话(${record.acpId.slice(0, 8)}…):${before}`
                + '下一轮请求的上下文占用会随之回落。',
        };
    }
    catch (error) {
        return {
            kind: 'error',
            text: `压缩转发失败: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
    finally {
        conn.kill();
    }
}
/** 非 codebuddy 会话:保持 dsh 自己的手动压缩行为。 */
async function dshCompact(deps, invocation) {
    const compaction = deps.ctx.get('compaction');
    if (compaction?.compactNow === undefined) {
        return { kind: 'error', text: '压缩服务不可用。' };
    }
    try {
        const result = await compaction.compactNow(invocation.agent, invocation.signal, invocation.commandId);
        if (result === null)
            return { kind: 'success', text: 'No compactable history yet.' };
        return {
            kind: 'success',
            text: `Compacted ${result.shadowedSeqs.length} history items (~${result.shadowedTokenCount} tokens).`,
        };
    }
    catch (error) {
        if (invocation.signal.aborted)
            return { kind: 'error', text: 'Compaction cancelled.' };
        return { kind: 'error', text: `Compaction failed: ${error instanceof Error ? error.message : String(error)}` };
    }
}
/**
 * 自动压缩委托:compaction-basic 在阈值触发时先发 `compaction/delegate`。
 *
 * **codebuddy 会话在此一律回报 handled —— dsh 不参与压缩。**
 * 真实上下文与压缩都由 CLI 自己负责(buddy 按自身策略压缩其会话);dsh 侧消息
 * 只是渲染镜像。所以这里**既不做 dsh 压缩,也不代 CLI 发起压缩**,只声明
 * "由我方处理",让 compaction-basic 走 `if (delegated?.handled === true) return null`
 * 跳过自身压缩。若让 dsh 压,有两个害处:① 压不动真实压力(dsh 的测量以 CLI 的
 * usage 为基线,压缩对象却是 dsh 侧残余);② 被压掉的消息会**从 UI 上消失**
 * (替换成摘要)——用户直接看到"消息被删了"。
 *
 * 为什么不能在这里转发 `/compact` 给 CLI(源码核对 + 实测):本委托的**两个**
 * 触发点都在回合进行中——`agent/pre-step` 的 pressure(`compaction-basic:154`)
 * 与 `agent/request-error` 的 context-overflow(`:195`);而 `runMaintenance`
 * 只在 agent `phase==='idle'` 时可用(`agent-loop/src/agent.ts:157`,否则同步
 * 抛错),自动路径**必然**拿不到 maintenance 相位。此时若另开第二条 CLI 连接
 * 去压,又会与回合泵持有的同一会话冲突(压缩结果会被回合泵的 CLI 覆盖)。
 * 故自动压缩交回 CLI 自身,插件不介入。
 *
 * 手动 `/compact` 不受影响:它走 per-agent 命令覆盖(`handleCompactCommand`),
 * 在回合空闲时由用户触发,那里才转发 CLI 并等 maintenance 相位。
 * @param deps - 挂载依赖(命令/参数/会话映射)。
 */
export function registerCompactDelegation(deps) {
    const onDelegate = async (request, next) => {
        const sessionId = request.agent?.session?.id;
        // 非 codebuddy 会话:dsh 自己的压缩,行为不变。
        if (typeof sessionId !== 'string' || deps.conversations.get(sessionId) === undefined)
            return await next();
        // codebuddy 会话:dsh 不参与——真实压缩由 CLI 自行完成。
        return { handled: true };
    };
    deps.ctx.on?.('compaction/delegate', onDelegate);
}
/**
 * 处理一次 /compact:codebuddy 会话转发 CLI,其它回落 dsh。
 * @param deps - 挂载依赖。
 * @param invocation - 命令调用。
 * @returns 命令结果。
 */
export async function handleCompactCommand(deps, invocation) {
    if (invocation.rawInput.trim().length > 0) {
        return { kind: 'error', text: 'Usage: /compact (no arguments)' };
    }
    const sessionId = invocation.agent.session.id;
    if (deps.conversations.get(sessionId) === undefined)
        return await dshCompact(deps, invocation);
    const cwd = invocation.agent.session.header.cwd ?? process.cwd();
    const agent = invocation.agent;
    if (agent.runMaintenance === undefined)
        return await forwardCompactToCli(deps, sessionId, cwd, invocation.signal);
    // 必须在 agent 的 maintenance 相位里压缩(与 dsh 原生 compactNow 一致):
    // 否则压缩期间发来的消息会立刻开新回合抢跑,该轮请求与压缩并发写同一个
    // CLI 会话,把压缩结果盖掉(实测:压缩期间开的那轮之后 prompt 反而继续涨)。
    // 进 maintenance 后消息按原生行为排队(latch 到压缩结束再跑)。
    try {
        return await agent.runMaintenance(async (agentSignal) => {
            const signal = AbortSignal.any([agentSignal, invocation.signal]);
            return await forwardCompactToCli(deps, sessionId, cwd, signal);
        });
    }
    catch {
        if (invocation.signal.aborted)
            return { kind: 'error', text: '压缩已取消。' };
        // runMaintenance 只在 agent 非 idle 时抛错。
        return { kind: 'error', text: '会话的回合正在运行中:等它结束后再压缩(避免与 CLI 的连接冲突)。' };
    }
}
/**
 * 在每个 agent 的 ctx 挂载 `compact` 命令(per-agent 覆盖全局注册)。
 * 没挂上的 agent 继续用全局的 command-compact。
 * @param deps - 挂载依赖。
 */
export function mountCompactCommand(deps) {
    deps.ctx.inject(['commands'], (commandCtx) => {
        commandCtx.on('agent/created', (payload) => {
            // cordis 的服务访问必须在 inject 作用域内(直接读 agent.ctx.commands 会抛
            // "cannot get property \"commands\" without inject",并让 session/create 失败)。
            const agentCtx = payload.agent?.ctx;
            if (agentCtx?.inject === undefined)
                return;
            agentCtx.inject(['commands'], (scoped) => {
                const face = scoped;
                if (face.commands?.register === undefined)
                    return;
                try {
                    face.commands.register({
                        name: 'compact',
                        description: 'Compact conversation history (CodeBuddy sessions: sent to the CLI)',
                        handler: invocation => handleCompactCommand(deps, invocation),
                    });
                }
                catch { /* 重复挂载/名字冲突:保留全局命令 */ }
            });
        });
    });
}
