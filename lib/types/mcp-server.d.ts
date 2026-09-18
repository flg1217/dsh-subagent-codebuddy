/**
 * dsh MCP server(HTTP):把**会话可见的 dsh 工具**以 MCP 协议暴露给 CodeBuddy CLI。
 *
 * 为什么走 MCP(对照 delegate 通道):CLI 对 delegate 合成的 `DelegateTool` 参数
 * 是无结构的 `input: object`——模型端几乎零约束(实测高频平铺/错名/空参);
 * MCP 工具在 CLI 里是**一等公民**(完整 JSON Schema 随协议下发,模型端强约束,
 * 与 dsh 原生链路的 API tools 同强度),且 CLI 对 MCP 工具有内建的延迟加载
 * (DeferExecuteTool)与周期性 tools/list 刷新。
 *
 * 链路:
 *   CLI(每回合 spawn,`--mcp-config` 指向本端点)
 *     → POST /api/dsh-mcp?session=<dsh会话>&key=<secret> (JSON-RPC over HTTP)
 *     → initialize / tools/list / tools/call
 *     → tools/list 现取 schemas(agent);tools/call 走 {@link runDshBridgeTool}
 *       (dsh 官方工具管线:审批/沙箱/事件与原生一致)
 *
 * **动态注册与发现**:
 * - `tools/list` **每次请求都现取** `ctx.tools.schemas(agent)`(不缓存)——会话
 *   可见工具的增删(插件装载、per-agent scope 变化)在下次 list 即反映;
 * - CLI 每回合新进程新连接(`--mcp-config` 含会话 id),天然按会话刷新;
 * - CLI 自身会周期性重发 tools/list(实测),进一步兜住连接内的变化;
 * - v1 不实现 `notifications/tools/list_changed`(需要 SSE 通道;上述两条
 *   已覆盖实际变化面)。
 *
 * 安全:仅接受 loopback 来源 + URL 携带每进程随机 key(双重校验);端点挂在
 * dsh 自带 webserver 上(与 Web UI 同端口),不额外开监听。
 *
 * **传输层现状(v1,刻意简化)**:MCP 规范里本端点是 "Streamable HTTP",但本
 * 实现只做 **JSON-only** 子集——每个请求单次 JSON 响应,不实现:
 * - `Accept` 协商(规范:客户端发 `application/json, text/event-stream`;若只
 *   接受 SSE 应回 406)——当前一律回 `application/json`;
 * - `Mcp-Session-Id` 响应头(即无有状态会话;本实现改用 URL query 的 `session`
 *   参数标识会话,能用但不是规范机制);
 * - `GET`(server→client 的 SSE 流)返回 405(规范允许服务端不提供);
 * - `notifications/tools/list_changed`(见上文"动态注册与发现"的兜底说明)。
 * 以上对当前 CLI 客户端实测可用;若 CLI 升级为严格客户端,这里是首个断裂点。
 * @module subagent-codebuddy/mcp-server
 */
import type { Context } from '@deepseek-ai/cordis';
import type { DshToolRunResult } from './dsh-tools-bridge.js';
/** 端点路径(exact 路由,挂 dsh webserver)。 */
export declare const DSH_MCP_ENDPOINT_PATH = "/api/dsh-mcp";
/** MCP server 名(CLI 侧工具呈现为 `mcp__dsh__<工具名>`)。 */
export declare const DSH_MCP_SERVER_NAME = "dsh";
/**
 * 转发兜底超时标记(pump.dispatchMcpCall 抛给端点)。
 *
 * 触发条件:注入的调用在 `MCP_CALL_TIMEOUT_MS` 内未被 loop 消费(loop 卡死等
 * 异常;正常路径由泵的 `finish()/dispose()` 释放等待者,不依赖本超时)。
 * 此时**无法确定**工具是否已在 loop 侧开始执行——所以端点收到本类型必须原样回
 * isError、**不得降级重跑**(重跑会让同一副作用执行两次),与"泵不在、工具尚未
 * 执行"的一般转发失败区别对待。
 */
export declare class McpDispatchTimeoutError extends Error {
    constructor(message: string);
}
/** MCP → loop 转发器(由回合泵在生命周期内注册)。 */
export type McpLoopDispatcher = (sessionId: string, name: string, input: Record<string, unknown>, 
/**
 * 转发超时后结果迟到时的投递口(泵在 tool/result 到达时调用)。
 * 交互式工具(ask_user_question 等)用户作答慢于转发超时窗口时,CLI 收到的
 * 是超时错误而不是答案;没有这个口子,答案就永久丢失(CLI 只能重问)。
 */
lateSink?: (toolName: string, text: string) => void) => Promise<DshToolRunResult>;
/**
 * 注册/注销会话的 MCP→loop 转发器(回合泵构造/释放时调用;幂等注销)。
 * @param sessionId - dsh 会话 id。
 * @param dispatch - 转发实现。
 * @returns 注销函数。
 */
export declare function registerMcpLoopDispatcher(sessionId: string, dispatch: McpLoopDispatcher): () => void;
/**
 * 注册 MCP 端点(插件初始化时调用一次;幂等)。
 * @param ctx - 插件上下文(webserver/agents/tools 服务)。
 * @returns 释放函数。
 */
export declare function registerDshMcpServer(ctx: Context): () => void;
/**
 * 清扫陈旧 `--mcp-config` 文件(插件启动时一次,尽力而为)。
 *
 * 文件按"会话+内容摘要"命名:每进程新 key、端口变化、测试套件运行都会生成
 * 新文件,只增不删会持续堆积;且文件内含端点 key,同用户任意进程可读。阈值
 * 取 1 小时:任何可能仍被在启 CLI 读取的配置都远新于此,多实例/多进程共享
 * 同一 temp 目录时也不会误删在用的文件。
 * @param dir - 目标目录(默认 {@link mcpConfigDir};测试可注入)。
 * @param maxAgeMs - 超过该年龄(毫秒)的文件删除,默认 1 小时。
 * @returns 实际删除的文件数(测试用)。
 */
export declare function sweepStaleMcpConfigs(dir?: string, maxAgeMs?: number): number;
/**
 * 生成会话专属的 `--mcp-config` 文件并返回其路径。
 * @param dshSessionId - 会话 id(URL 携带,端侧据此解析 per-agent 工具集)。
 * @returns 配置文件路径;端点未就绪时 undefined(调用方跳过该参数)。
 */
export declare function writeDshMcpConfigFile(dshSessionId: string): string | undefined;
/**
 * spawn 参数:bridgeMode **显式等于 `mcp`** 时生成会话专属 MCP 配置并返回
 * `--mcp-config` 参数。
 * @param bridgeMode - 桥接模式(undefined 与 delegate 同义:不注入)。
 * @param dshSessionId - 会话 id(MCP URL 携带,端侧据此解析 per-agent 工具集)。
 * @returns 追加到 CLI argv 的参数(空数组表示不启用 MCP 通道)。
 */
export declare function mcpConfigArgs(bridgeMode: 'mcp' | 'delegate' | undefined, dshSessionId: string | undefined): string[];
