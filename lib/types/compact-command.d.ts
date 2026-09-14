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
import type { Context } from '@deepseek-ai/cordis';
import type { ConversationStore } from './conversations.js';
/** 命令结果(与 dsh commands 服务的形状一致)。 */
export type CompactCommandResult = {
    kind: 'success';
    text?: string;
} | {
    kind: 'error';
    text: string;
};
/** 命令调用我们消费的部分。 */
export interface CompactInvocation {
    readonly commandId: string;
    readonly rawInput: string;
    readonly signal: AbortSignal;
    readonly agent: {
        readonly session: {
            readonly id: string;
            readonly header: {
                readonly cwd?: string;
            };
        };
    };
}
/** 挂载依赖(由插件 apply 提供)。 */
export interface CompactCommandDeps {
    ctx: Context;
    /** CLI 可执行(与 provider 的 command 一致)。 */
    command: string;
    prefixArgs: string[];
    extraArgs: string[];
    modelOf: () => string;
    conversations: ConversationStore;
    /** 该会话的回合泵是否在跑(默认查 TurnPump;测试可注入)。 */
    isSessionBusy?: (sessionId: string) => boolean;
}
/**
 * 把一条 `/compact` 转发给该会话的 CLI(短连接 resume + 用户命令 prompt)。
 * @param deps - 挂载依赖(命令/参数/会话映射)。
 * @param sessionId - dsh 会话 id(经映射找到 CLI 会话)。
 * @param cwd - CLI 工作目录。
 * @param signal - 命令取消信号。
 * @returns 命令结果。
 */
export declare function forwardCompactToCli(deps: CompactCommandDeps, sessionId: string, cwd: string, signal: AbortSignal): Promise<CompactCommandResult>;
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
export declare function registerCompactDelegation(deps: CompactCommandDeps): void;
/**
 * 处理一次 /compact:codebuddy 会话转发 CLI,其它回落 dsh。
 * @param deps - 挂载依赖。
 * @param invocation - 命令调用。
 * @returns 命令结果。
 */
export declare function handleCompactCommand(deps: CompactCommandDeps, invocation: CompactInvocation): Promise<CompactCommandResult>;
/**
 * 在每个 agent 的 ctx 挂载 `compact` 命令(per-agent 覆盖全局注册)。
 * 没挂上的 agent 继续用全局的 command-compact。
 * @param deps - 挂载依赖。
 */
export declare function mountCompactCommand(deps: CompactCommandDeps): void;
