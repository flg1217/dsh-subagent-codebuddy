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
    /** 本插件注册的 provider 名:自动压缩按"最新请求是否路由到它"判定归属。 */
    providerName: string;
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
 * 自动压缩接管:codebuddy 会话**一律不做 dsh 压缩** —— dsh 只是渲染层,
 * 真实上下文与压缩都由 CLI 自己负责。
 *
 * **为什么必须拦在 `compactIfNeeded` 上(2026-09-14 实测):** dsh 侧没有
 * "把压缩委托出去"的事件缝(曾按 `compaction/delegate` 事件写过一版,源码核对
 * 后确认 compaction-basic 从不发这个事件 → 监听器永不触发,等于死代码)。
 * 现在改为在 `ctx.compaction` 服务实例上就地接管压缩入口:compaction-basic
 * 的两条自动路径(`agent/pre-step` 的 pressure、`agent/request-error` 的
 * context-overflow)都是 `this.compactIfNeeded(...)`,实例上的自有属性会遮蔽
 * 原型方法,所以接管后 dsh 不再压 codebuddy 会话。
 * (源码核对:全仓 `compactIfNeeded` 只有这 2 处调用点,`compactNow` 只有
 * command-compact 一处;两者都接管后,dsh 侧没有任何路径能压 codebuddy 会话。)
 *
 * **不接管的害处(实测复现):** dsh 的压力测量以 CLI 上报的 usage 为基线
 * (CLI 的真实上下文),能压的却只有 dsh 侧的镜像消息;压完压力不降 → 下一个
 * step 再次触发 → 每个 step 都跑一次摘要,而 `region.ts` 的收缩闸门
 * (`summary is not smaller than the shadowed content`)在镜像面只剩旧摘要时
 * 必然拒绝,于是 11 分钟内连打 20+ 次 `compaction/start` → `compaction/end(error)`
 * (压缩风暴);偶发成功的那几次还会把镜像面替换成摘要,模型随即"重新找方向"
 * (日志里出现 "Let me re-orient"),界面上也多出一张本不该有的压缩卡。
 *
 * 注意 dsh 的 replace **不会隐藏或删除任何历史消息**(UI 照常渲染被遮蔽的消息,
 * 历史接口也不做过滤)——它改的是 dsh 的 **surface**:上下文压力表,以及插件
 * 需要重建 CLI 上下文时的素材(`buildPrompt` / 原生 seed)。所以接管要彻底:
 * 那两条自动路径 + `compactNow` 兜底都不许压 codebuddy 会话。
 *
 * 手动 `/compact` 不受影响:它走 per-agent 命令覆盖(`handleCompactCommand`),
 * 在回合空闲时由用户触发,那里才转发 CLI 并等 maintenance 相位。`compactNow`
 * 的接管只是兜底(命令覆盖没挂上时全局命令会走到它),避免那条路压镜像。
 * @param deps - 挂载依赖(路由名与会话映射)。
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
