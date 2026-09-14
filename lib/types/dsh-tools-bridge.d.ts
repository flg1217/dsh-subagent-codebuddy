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
 * 该 dsh 工具名是否可以暴露给 CLI(桥与 MCP 两条通道共用同一资格判定)。
 *
 * 排除:ptc 保留名(run_code)、MCP 工具(走 CLI 原生 MCP 通道)、CLI 镜像
 * 代理(cli_*,只在会话 scope 里承接原生调用)、被镜像占名的工具(read_image)、
 * 本机跑不动的平台专用工具({@link platformExcluded}:win32 无 bash、非 win32
 * 无 pwsh)。
 */
export declare function isBridgeEligible(name: string): boolean;
/**
 * 列出当前会话可见、应当桥接的全部 dsh 工具(delegate tool 描述符)。
 * 工具集来自 `ctx.tools.schemas(agent)`——dsh 的 per-agent scope 过滤已生效。
 * @param ctx - 插件上下文(tools 服务)。
 * @param parent - 会话的 agent(scope 与执行归属)。
 * @returns 桥工具描述符(不含专用委托工具)。
 */
export declare function listDshBridgeTools(ctx: Context, parent: Agent): DelegateToolSpec[];
/** 暴露给 MCP 通道的工具描述(MCP tools/list 条目)。 */
export interface McpToolSpec {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
}
/**
 * 列出当前会话可见、应通过 MCP 暴露的全部 dsh 工具。
 *
 * 与桥同名同源:工具集来自 `ctx.tools.schemas(agent)`(per-agent scope 过滤
 * 已生效),过滤规则共用 {@link isBridgeEligible}。与桥的差异:MCP 的工具是
 * 一等公民(自带完整 inputSchema),所以 name 用**裸原名**(CLI 侧呈现为
 * `mcp__<server>__<name>`)、description 用原描述 + 执行提示,不注入
 * "调用形态"提示(结构化 schema 已是强约束)。
 *
 * **动态性**:每次 tools/list 都现取 schemas——会话可见工具增删(插件装载、
 * scope 变化)在下一次 list 即反映;配合 CLI 对 MCP 的周期性 list(实测),
 * 无需另行缓存或失效逻辑。
 * @param ctx - 插件上下文(tools 服务)。
 * @param parent - 会话的 agent(scope 与执行归属)。
 * @returns MCP 工具条目(每次调用现算)。
 */
export declare function listDshMcpTools(ctx: Context, parent: Agent): McpToolSpec[];
/**
 * 工具结果内容块 → 文本(嵌套 tool-result 递归,图片块降级为提示)。
 * 桥执行与真工具直发路径共用同一文本口径。
 */
export declare function blocksToText(content: readonly unknown[]): string;
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
