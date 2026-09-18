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
import type { DelegateToolSpec } from './delegate.js'

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
 * 平台专用工具:本机跑不动就不进桥(与 preset 的 `disabled:` 门同一套规则)。
 *
 * 规则照抄 harness 的 preset 门:shell 工具按平台二选一——`tool-bash` 在
 * win32 禁用、`tool-pwsh` 只在 win32 挂载。preset 正常已把它挡在 agent
 * scope 之外(`schemas()` 就看不到),但 preset 是用户可改的(自定义 preset /
 * 宿主组合可能照挂两个),一旦 `bash` 进了 tools/list,模型就会顺着
 * `mcp__dsh__*` 命名习惯去调 `mcp__dsh__bash`;CLI 对不存在的工具直接判
 * `ModelBehaviorError` 结束 run(实测 2026-09-14:该错误的重试窗口又撞上泵的
 * 静默兜底,对话无声中断)。桥这层按平台再剔一次,保证下发给 CLI 的工具面
 * 只含本机跑得动的工具。
 */
function platformExcluded(name: string): boolean {
  if (name === 'bash') return process.platform === 'win32'
  if (name === 'pwsh') return process.platform !== 'win32'
  return false
}

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
 * 代理(cli_*,只在会话 scope 里承接原生调用)、本机跑不动的平台专用工具
 * ({@link platformExcluded}:win32 无 bash、非 win32 无 pwsh)。
 *
 * `read_image` **不再排除**(曾经被裸名镜像占名):CLI 内置工具已全部禁用,
 * 读图改走 dsh 真工具,结果经 MCP 响应以 image 内容块回传
 * ({@link blocksToMcpContent})。
 */
export function isBridgeEligible(name: string): boolean {
  if (name.length === 0) return false
  if (BRIDGE_EXCLUDED.has(name)) return false
  if (platformExcluded(name)) return false
  if (name.startsWith(MCP_TOOL_PREFIX)) return false
  if (name.startsWith(CLI_MIRROR_TOOL_PREFIX)) return false
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
 * 桥工具执行结果。
 *
 * `output` = 协议回灌文本(delegate 通道只认它);`content` = 工具原始内容块,
 * 供 MCP 通道承载图片({@link blocksToMcpContent});delegate 协议没有图片通道,
 * 该字段在那里被忽略。
 */
export interface DshToolRunResult {
  output: string
  isError: boolean
  content?: readonly unknown[]
}

/** dsh `ctx.attachments` 的读图面(与原生 read_image 同法的单图取字节)。 */
export interface AttachmentsReadFace {
  readImage(ref: unknown): Promise<{ data: Uint8Array; ref: { mediaType: string } }>
}

/** MCP `content` 数组的元素(本实现只产出 text 与 image 两种)。 */
export type McpContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

/**
 * 工具结果内容块 → MCP content parts(图片经 attachments 读字节转 base64)。
 *
 * 只在**确有图片且字节可读**时返回完整 parts(文本 + image);其余情况返回
 * undefined,调用方沿用纯文本单块响应。为什么必须走 MCP 的 image 内容类型:
 * CLI 的 `executeMcpTool → convertMcpResult` 遇到 `{type:'image',data}` 会把
 * 整个内容数组序列化成带 `image_url` 的 JSON 交给它自己的模型(与 CLI 原生
 * Read 读图的落点完全相同);纯文本路径下图片只能退化成占位符。
 * @param attachments - dsh attachments 服务面(缺失即放弃转换)。
 * @param content - 工具结果内容块(tool/result 事件的 content)。
 * @returns MCP content parts,或 undefined(无图片/有图但读不出——整体回退)。
 */
export async function blocksToMcpContent(
  attachments: AttachmentsReadFace | undefined,
  content: readonly unknown[],
): Promise<McpContentPart[] | undefined> {
  if (attachments === undefined) return undefined
  const parts: McpContentPart[] = []
  let images = 0
  let failed = false
  const walk = async (blocks: readonly unknown[]): Promise<void> => {
    for (const block of blocks) {
      if (failed) return
      if (block === null || typeof block !== 'object') continue
      const typed = block as { type?: unknown; text?: unknown; content?: unknown; attachment?: unknown }
      if (typed.type === 'text' && typeof typed.text === 'string') {
        parts.push({ type: 'text', text: typed.text })
        continue
      }
      if (typed.type === 'tool-result' && Array.isArray(typed.content)) {
        await walk(typed.content as readonly unknown[])
        continue
      }
      if (typed.type === 'image') {
        try {
          const stored = await attachments.readImage(typed.attachment)
          parts.push({
            type: 'image',
            data: Buffer.from(stored.data).toString('base64'),
            mimeType: stored.ref.mediaType,
          })
          images += 1
        } catch {
          // 有图读不出:整体回退(不半转换,避免模型看到"缺了图"的结果)。
          failed = true
        }
        continue
      }
      try {
        parts.push({ type: 'text', text: JSON.stringify(block) })
      } catch { /* 不可序列化块跳过 */ }
    }
  }
  await walk(content)
  return !failed && images > 0 ? parts : undefined
}

/**
 * 工具结果内容块 → 文本(嵌套 tool-result 递归,图片块降级为提示)。
 * 桥执行与真工具直发路径共用同一文本口径(delegate 通道的图片回退文案在此)。
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
 * @returns 执行结果(永不抛错——错误按 isError 回;`content` 供 MCP 通道回传
 *   图片,delegate 通道只读 `output`)。
 */
export async function runDshBridgeTool(
  ctx: Context,
  options: DelegatedDshToolOptions,
): Promise<DshToolRunResult> {
  const parent = ctx.get('agents')?.get(options.parentSessionId as SessionId)
  if (parent === undefined) {
    return { output: `dsh tool "${options.toolName}": parent agent "${options.parentSessionId}" is not live`, isError: true }
  }
  const tools = ctx.get('tools')
  if (tools === undefined) {
    return { output: `dsh tool "${options.toolName}": the tools service is unavailable`, isError: true }
  }
  try {
    const result = await tools.execute({
      callId: randomUUID() as unknown as ToolCallId,
      name: options.toolName,
      arguments: options.input,
      agent: parent,
      signal: options.signal ?? new AbortController().signal,
    })
    const content = result.content as readonly unknown[]
    const text = blocksToText(content)
    return result.isError
      ? { output: text, isError: true }
      : { output: text, isError: false, content }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return { output: `dsh tool "${options.toolName}" failed: ${message}`, isError: true }
  }
}
