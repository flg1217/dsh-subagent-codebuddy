/**
 * dsh 工具 → CodeBuddy 委托工具的**通用桥**。
 *
 * CodeBuddy 的 delegate tools 机制只要求 `{id,name,description,inputSchema}`:
 * 把 dsh 侧当前会话可见的全部工具(含 MCP)自动注册为 `dsh_<原名>` 委托工具,
 * 模型调用时经 `ctx.tools.execute` 走 dsh 的**完整执行管线**——审批、沙箱、
 * 事件与追踪和原生执行完全一致——结果回灌给 CLI。
 *
 * 命名与排除:
 * - 统一前缀 `dsh_`(与 CLI 自带同名工具区分,模型一眼看出是 dsh 侧);
 * - 排除 `bash`/`pwsh`(执行类已有 dsh_bash:job 化 + 完成通知 + 面板可见)
 *   与 `subagent`(已有 dsh_subagent 专用委托)、`run_code`(ptc 保留名);
 * - 剩余工具(读/搜/写/MCP…)全量桥接——工具集由 dsh 的 per-agent scope
 *   过滤决定,插件不重复维护清单;
 * - `cli_` 前缀是会话内 CLI 镜像代理的保留名(见 {@link CLI_MIRROR_TOOL_PREFIX}),
 *   既不暴露给 CLI 也不受理桥调用。
 *
 * @module subagent-codebuddy/dsh-tools-bridge
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { DelegateToolResult, DelegateToolSpec } from './delegate.js';
/** 桥工具 id 前缀。 */
export declare const BRIDGE_TOOL_PREFIX = "dsh_";
/**
 * 会话内「CLI 镜像工具」的保留前缀(pump 的 `ensureReplayTool` 注册的回放代理)。
 *
 * 为什么必须有这个前缀:CLI 原生工具(read/bash/…)的调用要进 dsh 会话,就得
 * 在会话 agent scope 里注册一个**同名**代理工具承接(等 CLI 的真实结果)。但
 * 同名注册会**遮蔽 dsh 真工具**——CLI 用过原生 `read` 后,桥的 `dsh_read` 经
 * `ctx.tools.execute` 命中镜像代理,拿到「未知的工具调用(该调用不属于当前回合)」
 * (实测:模型据此判定 dsh_read 坏掉,整轮对话开始乱试)。
 * 让镜像统一叫 `cli_read`,与真工具彻底分名,桥照旧解析真 `read`。
 */
export declare const CLI_MIRROR_TOOL_PREFIX = "cli_";
/** dsh 工具名 → 桥工具 id。 */
export declare function bridgeToolId(name: string): string;
/** 桥工具 id → dsh 工具名;非桥命名、ptc 保留名、MCP 或 CLI 镜像名时返回 undefined。 */
export declare function bridgeTargetTool(toolId: string): string | undefined;
/**
 * 列出当前会话可见、应当桥接的全部 dsh 工具(delegate tool 描述符)。
 * 工具集来自 `ctx.tools.schemas(agent)`——dsh 的 per-agent scope 过滤已生效。
 * @param ctx - 插件上下文(tools 服务)。
 * @param parent - 会话的 agent(scope 与执行归属)。
 * @returns 桥工具描述符(不含专用委托工具)。
 */
export declare function listDshBridgeTools(ctx: Context, parent: Agent): DelegateToolSpec[];
/** 执行一次桥工具调用:走 dsh 的完整工具管线,结果转文本回 CLI。 */
export interface DelegatedDshToolOptions {
    /** 发起会话(dsh 会话 id;执行归属的 agent)。 */
    parentSessionId: string;
    /** dsh 工具真名(已由 bridgeTargetTool 解析)。 */
    toolName: string;
    /** CLI 传来的工具参数。 */
    input: Record<string, unknown>;
    /** 回合取消信号(中止时取消工具执行)。 */
    signal?: AbortSignal;
}
/**
 * 执行一次桥接的 dsh 工具调用。
 * @param ctx - 插件上下文(agents / tools 服务)。
 * @param options - 调用参数。
 * @returns CLI 侧 DelegateTool 的响应对象(永不抛错——错误按协议回 status:'error')。
 */
export declare function runDshBridgeTool(ctx: Context, options: DelegatedDshToolOptions): Promise<DelegateToolResult>;
