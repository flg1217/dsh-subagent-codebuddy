/**
 * CodeBuddy 委托工具(delegate tools)的注册面。
 *
 * CodeBuddy 的 ACP 客户端可注册"客户端侧工具":CLI 把它们合成内置
 * `DelegateTool` 暴露给模型(initialize 响应的 `delegateToolsSupport: true`),
 * 模型调用时 CLI 经 extMethod `_codebuddy.ai/delegateTool` 回调客户端执行。
 *
 * 本插件把 dsh 侧的**全部工具**以 `dsh_<原名>` 注册为 delegate tools
 * (见 dsh-tools-bridge):调用经 `ctx.tools.execute` 走 dsh 官方工具管线——
 * 审批、沙箱、事件与原生执行完全一致。MCP 工具走 CLI 的原生 MCP 通道、
 * Skill 走 CLI 的 skill 目录,都不经此注册面。
 *
 * 协议形状(实测自 CLI 产物):
 * - 注册(我们 → CLI):`_codebuddy.ai/delegateToolsChanged`
 *   `{ sessionId, changeType:'added', tools:[{id,name,description,inputSchema,provider}] }`
 *   → CLI 把工具注入模型 prompt;没有注册过工具时内置 DelegateTool 会被整个过滤。
 * - 调用(CLI → 我们):`_codebuddy.ai/delegateTool`
 *   `{ toolCallId, toolId, input, timeout }`
 *   → 我们回 `{status:'success',output}`(output 直接成为工具 content)
 *     或 `{status:'error',error:{message}}`。
 * @module subagent-codebuddy/delegate
 */
/** 委托工具调用的 extMethod 名(CLI → 客户端)。 */
export const DELEGATE_TOOL_METHOD = '_codebuddy.ai/delegateTool';
/** 委托工具变更通知的方法名(客户端 → CLI)。 */
export const DELEGATE_TOOLS_CHANGED_METHOD = '_codebuddy.ai/delegateToolsChanged';
/**
 * 注册委托工具(客户端 → CLI)。每个 ACP 会话注册一次即可;失败不应打断回合
 * (调用方吞掉并记日志),下次会话会重试注册。
 * @param request - 连接的 request 面。
 * @param sessionId - 本次 ACP 会话 id(CLI 用它给工具分组/清理)。
 * @param tools - 要注册的工具列表(每次一批,便于失败隔离)。
 */
export async function announceDelegateTools(request, sessionId, tools) {
    if (tools.length === 0)
        return;
    await request(DELEGATE_TOOLS_CHANGED_METHOD, {
        sessionId,
        changeType: 'added',
        tools: tools.map(tool => ({
            id: tool.id,
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            provider: 'dsh-subagent',
        })),
    });
}
