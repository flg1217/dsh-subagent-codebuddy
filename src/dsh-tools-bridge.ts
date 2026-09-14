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

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-tools'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { DelegateToolResult, DelegateToolSpec } from './delegate.js'

/** 桥工具 id 前缀。 */
export const BRIDGE_TOOL_PREFIX = 'dsh_'

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
export const CLI_MIRROR_TOOL_PREFIX = 'cli_'

/**
 * 不桥接的 dsh 工具名。
 *
 * 完全统一:bash/pwsh/subagent 等全部走桥(指向 dsh 原生工具——原生
 * subagent 本就是 continuable、原生 bash 支持 run_in_background→dsh jobs)。
 * 排除两类:
 * - `run_code`(ptc 模式的保留名,原生模式暴露无意义);
 * - **MCP 工具**(`mcp__*`)——它们走 CLI 的原生 MCP 通道(见 mcp 接入),
 *   不经工具桥往返。
 */
const BRIDGE_EXCLUDED = new Set(['run_code'])

/** MCP 工具名前缀(dsh 与 CLI 同名约定)。 */
const MCP_TOOL_PREFIX = 'mcp__'

/**
 * 被 CLI 镜像工具占用的 dsh 工具名:不桥接、不受理。
 *
 * `read_image`:CLI 原生 Read 读图时,泵把这次调用以镜像工具 `read_image` 记进
 * dsh 会话——**名字必须与真工具一致**:dsh Web UI 的图片卡片按
 * `call.name === 'read_image'` 才出预览(image-card-model 硬编码),改名就退化成
 * 普通文本行(实测)。真工具因此被镜像遮蔽,桥便不再暴露 `dsh_read_image`
 * (调了也会打到镜像上):CLI 自带 Read 读图已覆盖该能力,且结果同样进 dsh。
 */
const BRIDGE_MIRROR_OWNED = new Set(['read_image'])

/** dsh 工具 schema(桥只需要这三个字段)。 */
interface DshToolSchemaFace {
  readonly name: string
  readonly description?: string
  readonly parameters?: unknown
}

/** 执行类工具的桥描述补充:强引导后台任务语义(默认后台 = dsh job)。 */
const EXECUTION_TOOLS = new Set(['bash', 'pwsh'])

const EXECUTION_HINT = ' IMPORTANT: for anything that may run more than a few seconds, pass `run_in_background: true` —'
  + ' the job then appears in the dsh background-jobs view and its completion notice wakes you to continue;'
  + ' a foreground call blocks until the command finishes (and may hit the delegate timeout).'

/** dsh 工具名 → 桥工具 id。 */
export function bridgeToolId(name: string): string {
  return `${BRIDGE_TOOL_PREFIX}${name}`
}

/**
 * 模型填写的 toolId 规范化为 dsh 原名。
 *
 * 模型对 DelegateTool 的 toolId 填写不稳定(实测:会把展示名 `Dsh-bash`
 * 当 toolId 传,也出现 `dsh-bash` 这类连字符变体)——统一剥前缀
 * (dsh_ / Dsh- / dsh-)、连字符归一为下划线、小写化(dsh 工具原名全小写,
 * 无损)。解析不出的原样返回,由调用方给 unknown 错误。
 */
function canonicalBridgeName(toolId: string): string {
  const raw = toolId.replace(/^(?:dsh_|Dsh-|dsh-)/, '')
  return raw.replace(/-/g, '_').toLowerCase()
}

/** 桥工具 id → dsh 工具名;非桥命名、ptc 保留名、MCP 或 CLI 镜像名时返回 undefined。 */
export function bridgeTargetTool(toolId: string): string | undefined {
  const name = canonicalBridgeName(toolId)
  if (!isBridgeEligible(name)) return undefined
  return name
}

/**
 * 该 dsh 工具名是否可以暴露给 CLI(桥与 MCP 两条通道共用同一资格判定)。
 *
 * 排除:ptc 保留名(run_code)、MCP 工具(走 CLI 原生 MCP 通道)、CLI 镜像
 * 代理(cli_*,只在会话 scope 里承接原生调用)、被镜像占名的工具(read_image)。
 */
export function isBridgeEligible(name: string): boolean {
  if (name.length === 0) return false
  if (BRIDGE_EXCLUDED.has(name)) return false
  if (name.startsWith(MCP_TOOL_PREFIX)) return false
  if (name.startsWith(CLI_MIRROR_TOOL_PREFIX)) return false
  if (BRIDGE_MIRROR_OWNED.has(name)) return false
  return true
}

/** CLI 展示名:唯一、可读(`dsh_grep` → `Dsh-grep`)。 */
function bridgeToolName(name: string): string {
  return `Dsh-${name.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 60)}`
}

/** 桥工具描述:原描述原样保留,只加最短身份标记(桥语义引导在 prompt 尾注,不逐工具拼说明)。 */
function bridgeDescription(name: string, original: string): string {
  const head = original.trim().length > 0
    ? `${original.trim()}`
    : `(the dsh-side tool "${name}")`
  return `[dsh-side tool: "${name}"] ${head}`
}

/**
 * 调用形态提示:toolId + 参数名清单(从真实 schema 的 properties 提取)。
 *
 * CLI 合成 DelegateTool 的 input 字段是无结构的 object——模型端对"参数怎么
 * 包"完全没有 schema 约束(实测:模型把参数平铺在顶层、toolId 大小写混写、
 * 发空参——dsh 原生链路里 API tools 的结构化 schema 不会出现这类问题)。
 * 把"精确 toolId + 参数名单"钉在每个工具描述最前(截断也先保住),模型可
 * 直接照抄,把约束补回接近原生的强度。
 */
function callShapeHint(name: string, inputSchema: unknown): string {
  const properties = (inputSchema as { properties?: unknown } | undefined)?.properties
  const keys = properties !== null && typeof properties === 'object' && !Array.isArray(properties)
    ? Object.keys(properties as Record<string, unknown>).slice(0, 12)
    : []
  return `[call: toolId="dsh_${name}", input={${keys.join(', ')}}]`
}

/**
 * 列出当前会话可见、应当桥接的全部 dsh 工具(delegate tool 描述符)。
 * 工具集来自 `ctx.tools.schemas(agent)`——dsh 的 per-agent scope 过滤已生效。
 * @param ctx - 插件上下文(tools 服务)。
 * @param parent - 会话的 agent(scope 与执行归属)。
 * @returns 桥工具描述符(不含专用委托工具)。
 */
export function listDshBridgeTools(ctx: Context, parent: Agent): DelegateToolSpec[] {
  const tools = (ctx as unknown as { get?: (key: string) => unknown }).get?.('tools') as
    | { schemas?: (scope?: unknown) => readonly DshToolSchemaFace[] }
    | undefined
  let schemas: readonly DshToolSchemaFace[]
  try {
    schemas = tools?.schemas?.(parent) ?? []
  } catch (error: unknown) {
    // 不静默:空表会让 CLI 侧所有 dsh_* 调用都报 not found——必须能区分
    // "schemas 抛错"与"确实无工具",否则现场无从定位。
    console.error('[codebuddy-bridge] listDshBridgeTools: tools.schemas() 抛错,本次返回空工具表:'
      + (error instanceof Error ? error.message : String(error)))
    return []
  }
  const specs: DelegateToolSpec[] = []
  for (const schema of schemas) {
    if (typeof schema?.name !== 'string' || !isBridgeEligible(schema.name)) continue
    const inputSchema = (schema.parameters !== null && typeof schema.parameters === 'object'
      ? schema.parameters
      : { type: 'object', properties: {} }) as Record<string, unknown>
    const base = `${callShapeHint(schema.name, inputSchema)} ${bridgeDescription(
      schema.name,
      typeof schema.description === 'string' ? schema.description : '',
    )}`
    specs.push({
      id: bridgeToolId(schema.name),
      name: bridgeToolName(schema.name),
      description: EXECUTION_TOOLS.has(schema.name) ? base + EXECUTION_HINT : base,
      inputSchema,
    })
  }
  return specs
}

/** 暴露给 MCP 通道的工具描述(MCP tools/list 条目)。 */
export interface McpToolSpec {
  name: string
  description: string
  inputSchema: Record<string, unknown>
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
export function listDshMcpTools(ctx: Context, parent: Agent): McpToolSpec[] {
  const tools = (ctx as unknown as { get?: (key: string) => unknown }).get?.('tools') as
    | { schemas?: (scope?: unknown) => readonly DshToolSchemaFace[] }
    | undefined
  let schemas: readonly DshToolSchemaFace[]
  try {
    schemas = tools?.schemas?.(parent) ?? []
  } catch (error: unknown) {
    // 不静默:空表会让 tools/list 返回"零工具",CLI 侧表现为所有
    // mcp__dsh__* 调用都报 not found——必须能区分"schemas 抛错"与"确实无工具"。
    console.error('[codebuddy-bridge] listDshMcpTools: tools.schemas() 抛错,本次返回空工具表:'
      + (error instanceof Error ? error.message : String(error)))
    return []
  }
  const specs: McpToolSpec[] = []
  for (const schema of schemas) {
    if (typeof schema?.name !== 'string' || !isBridgeEligible(schema.name)) continue
    const inputSchema = (schema.parameters !== null && typeof schema.parameters === 'object'
      ? schema.parameters
      : { type: 'object', properties: {} }) as Record<string, unknown>
    const base = typeof schema.description === 'string' && schema.description.trim().length > 0
      ? schema.description.trim()
      : `(the dsh-side tool "${schema.name}")`
    specs.push({
      name: schema.name,
      description: EXECUTION_TOOLS.has(schema.name) ? base + EXECUTION_HINT : base,
      inputSchema,
    })
  }
  return specs
}

/**
 * 工具结果内容块 → 文本(嵌套 tool-result 递归,图片块降级为提示)。
 * 桥执行与真工具直发路径共用同一文本口径。
 */
export function blocksToText(content: readonly unknown[]): string {
  const parts: string[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const typed = block as { type?: unknown; text?: unknown; content?: unknown }
    if (typed.type === 'text' && typeof typed.text === 'string') {
      parts.push(typed.text)
      continue
    }
    if (typed.type === 'tool-result' && Array.isArray(typed.content)) {
      const inner = blocksToText(typed.content as readonly unknown[])
      if (inner.length > 0) parts.push(inner)
      continue
    }
    if (typed.type === 'image') {
      parts.push('[image result — not forwarded as an image over this bridge]')
      continue
    }
    try {
      parts.push(JSON.stringify(block))
    } catch { /* 不可序列化块跳过 */ }
  }
  const text = parts.join('\n')
  return text.length > 0 ? text : '(no output)'
}

/** 执行一次桥工具调用:走 dsh 的完整工具管线,结果转文本回 CLI。 */
export interface DelegatedDshToolOptions {
  /** 发起会话(dsh 会话 id;执行归属的 agent)。 */
  parentSessionId: string
  /** dsh 工具真名(已由 bridgeTargetTool 解析)。 */
  toolName: string
  /** CLI 传来的工具参数。 */
  input: Record<string, unknown>
  /** 回合取消信号(中止时取消工具执行)。 */
  signal?: AbortSignal
}

/**
 * 执行一次桥接的 dsh 工具调用。
 * @param ctx - 插件上下文(agents / tools 服务)。
 * @param options - 调用参数。
 * @returns CLI 侧 DelegateTool 的响应对象(永不抛错——错误按协议回 status:'error')。
 */
export async function runDshBridgeTool(
  ctx: Context,
  options: DelegatedDshToolOptions,
): Promise<DelegateToolResult> {
  const parent = ctx.get('agents')?.get(options.parentSessionId as SessionId)
  if (parent === undefined) {
    return { status: 'error', error: { message: `dsh tool "${options.toolName}": parent agent "${options.parentSessionId}" is not live` } }
  }
  const tools = ctx.get('tools')
  if (tools === undefined) {
    return { status: 'error', error: { message: `dsh tool "${options.toolName}": the tools service is unavailable` } }
  }
  try {
    const result = await tools.execute({
      callId: randomUUID() as unknown as ToolCallId,
      name: options.toolName,
      arguments: options.input,
      agent: parent,
      signal: options.signal ?? new AbortController().signal,
    })
    const text = blocksToText(result.content as readonly unknown[])
    return result.isError
      ? { status: 'error', error: { message: text } }
      : { status: 'success', output: text }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return { status: 'error', error: { message: `dsh tool "${options.toolName}" failed: ${message}` } }
  }
}
