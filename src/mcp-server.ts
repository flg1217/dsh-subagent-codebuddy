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

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import { blocksToMcpContent, isBridgeEligible, listDshMcpTools, runDshBridgeTool } from './dsh-tools-bridge.js'
import type { AttachmentsReadFace, DshToolRunResult, McpContentPart } from './dsh-tools-bridge.js'

/** 端点路径(exact 路由,挂 dsh webserver)。 */
export const DSH_MCP_ENDPOINT_PATH = '/api/dsh-mcp'

/** MCP server 名(CLI 侧工具呈现为 `mcp__dsh__<工具名>`)。 */
export const DSH_MCP_SERVER_NAME = 'dsh'

/** v1 声明的 MCP 协议版本(对齐实验通过的 CLI 行为)。 */
const MCP_PROTOCOL_VERSION = '2025-03-26'

/** 服务端支持的 MCP 协议版本集合(协商时只回其中的版本)。 */
const MCP_SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [MCP_PROTOCOL_VERSION]

/**
 * 转发兜底超时标记(pump.dispatchMcpCall 抛给端点)。
 *
 * 触发条件:注入的调用在 `MCP_CALL_TIMEOUT_MS` 内未被 loop 消费(loop 卡死等
 * 异常;正常路径由泵的 `finish()/dispose()` 释放等待者,不依赖本超时)。
 * 此时**无法确定**工具是否已在 loop 侧开始执行——所以端点收到本类型必须原样回
 * isError、**不得降级重跑**(重跑会让同一副作用执行两次),与"泵不在、工具尚未
 * 执行"的一般转发失败区别对待。
 */
export class McpDispatchTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'McpDispatchTimeoutError'
  }
}

/** 活跃端点的凭据(每插件进程一份)。 */
interface McpEndpoint {
  key: string
}

/** MCP → loop 转发器(由回合泵在生命周期内注册)。 */
export type McpLoopDispatcher = (
  sessionId: string,
  name: string,
  input: Record<string, unknown>,
  /**
   * 转发超时后结果迟到时的投递口(泵在 tool/result 到达时调用)。
   * 交互式工具(ask_user_question 等)用户作答慢于转发超时窗口时,CLI 收到的
   * 是超时错误而不是答案;没有这个口子,答案就永久丢失(CLI 只能重问)。
   */
  lateSink?: (toolName: string, text: string) => void,
) => Promise<DshToolRunResult>

/**
 * 会话 → 转发器。回合泵活着时注册:tools/call 交给泵伪装成工具调用块灌进
 * dsh loop 原生执行(审批/沙箱/事件/UI 卡片);泵不在(会话未跑回合)时回落
 * 直接执行({@link runDshBridgeTool})。
 */
const loopDispatchers = new Map<string, McpLoopDispatcher>()

/**
 * 注册/注销会话的 MCP→loop 转发器(回合泵构造/释放时调用;幂等注销)。
 * @param sessionId - dsh 会话 id。
 * @param dispatch - 转发实现。
 * @returns 注销函数。
 */
export function registerMcpLoopDispatcher(sessionId: string, dispatch: McpLoopDispatcher): () => void {
  loopDispatchers.set(sessionId, dispatch)
  return () => {
    if (loopDispatchers.get(sessionId) === dispatch) loopDispatchers.delete(sessionId)
  }
}

let endpoint: McpEndpoint | undefined
/** 实际监听端口解析(webserver listen 前 port 为 0;生成配置时现取)。 */
let resolvePort: (() => number) | undefined

/** webserver 服务面(最小结构类型,不引依赖)。 */
interface WebServerFace {
  register?: (route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }) => () => void
  port?: number
}

/** agents 服务面。 */
interface AgentsFace {
  get?: (sessionId: string) => unknown
}

/**
 * 投递要用的 agent 面。`inject` 把消息排进下一步;`followup` 额外在会话空闲时
 * 唤起一轮——客户端已放弃这次调用时,只有唤起才能让 CLI 被重新 prompt,模型才
 * 有机会看到结果。
 */
interface BridgeAgentFace {
  readonly status?: string
  inject?: (message: unknown) => void
  followup?: (message: unknown) => void
}

/** 取该会话的存活 agent 面(拿不到返回 undefined;服务缺失不抛)。 */
function liveAgentFace(ctx: Context, sessionId: string): BridgeAgentFace | undefined {
  try {
    const agents = (ctx as unknown as { get: (key: string) => unknown }).get('agents') as AgentsFace | undefined
    return agents?.get?.(sessionId) as BridgeAgentFace | undefined
  } catch {
    return undefined
  }
}

/**
 * 客户端放弃这次调用之后才拿到的结果,必须送回会话。
 *
 * CLI 侧一旦按超时/断连放弃,它的模型就永远看不到这次工具结果,而 dsh 侧不会因此
 * 中止已经注入 loop 的调用(见下方 `clientGoneAt` 说明)。对**交互式**工具尤其致命:
 * 用户在 `ask_user_question` / `exit_plan_mode` 上作答之后,回答送达的是一个已经
 * 消失的调用——界面上"提问结束就完了",不会有任何后续。这里把结果作为一条 notice
 * 投进会话:会话空闲就唤起一轮(CLI 被重新 prompt,模型据此继续),忙则排队等下一步。
 *
 * 只在客户端确实没收到响应时才投递(断连,或转发超时后 CLI 已收到超时错误),
 * 所以这不是重复上报。
 * @param ctx - 插件上下文(取 agents 服务)。
 * @param sessionId - dsh 会话 id。
 * @param toolName - 被调用的 dsh 工具名。
 * @param text - 工具结果正文。
 * @param reason - 客户端为什么没收到响应:断连 / 转发超时(决定开场措辞)。
 */
function deliverAfterClientGone(
  ctx: Context,
  sessionId: string,
  toolName: string,
  text: string,
  reason: 'client-gone' | 'dispatch-timeout' = 'client-gone',
): void {
  const agent = liveAgentFace(ctx, sessionId)
  if (agent === undefined) return
  const intro = reason === 'client-gone'
    ? `[dsh] 你先前调用 dsh 工具 \`${toolName}\` 时,客户端在结果返回前就放弃了这次调用`
      + '(CLI 侧多半已按超时处理)。该调用其实已经执行完成,结果如下:'
    : `[dsh] 你先前调用 dsh 工具 \`${toolName}\` 时,转发在结果返回前超时`
      + '(你当时收到的是超时错误)。该调用后来执行完成,真实结果如下:'
  const message = createUserMessage({
    content: [{
      type: 'text',
      text: `${intro}\n\n`
        + `${text}\n\n`
        + '这条结果不要再重跑同一条命令。',
    }],
    source: {
      kind: 'plugin',
      plugin: 'codebuddy-bridge',
      form: 'notice',
      // 摘要进 durable log 并渲染成折叠行,所以按 dsh 的 notice 上限截断。
      summary: boundContextSummary(reason === 'client-gone'
        ? `dsh 工具 ${toolName} 在客户端放弃后才返回,结果已补投`
        : `dsh 工具 ${toolName} 转发超时后完成,结果已补投`),
    },
  } as never)
  // 投递推迟到下一个宏任务:补投常发生在 tool/result 的**发布周期内**
  // (泵的 onSessionEvent → 迟到投递口回调链),此时立刻 followup/inject 会在
  // 发布中重入 session.append,被存储层拒绝("cannot reenter while another
  // append is being published",2026-09-17 实测),补投内容丢失。等发布收尾。
  const deliver = (): void => {
    try {
      if (agent.status === 'idle' && agent.followup !== undefined) {
        agent.followup(message)
        return
      }
      agent.inject?.(message)
    } catch (error: unknown) {
      bridgeLog(`补投失败:session=${sessionId} tool=${toolName} err=${error instanceof Error ? error.message : String(error)}`)
    }
  }
  setImmediate(deliver)
}

/**
 * 桥诊断落盘(`~/.dsh/codebuddy/mcp-bridge.log`)。
 *
 * 这些行原本只走 `console.error` 到前台终端,滚掉就没了——而它们正是判断
 * "CLI 到底有没有放弃这次调用"的唯一现场证据(`clientGoneAt` 打印的客户端等待
 * 时长就是实测的 CLI 侧工具超时 T_client)。不落盘就无法事后核对。
 * 测试不写这个文件:测试的诊断会混进生产记录里,让这份日志不可信。
 * @param line - 一行诊断。
 */
function bridgeLog(line: string): void {
  if (process.env['NODE_ENV'] === 'test') return
  try {
    mkdirSync(join(homedir(), '.dsh', 'codebuddy'), { recursive: true })
    appendFileSync(join(homedir(), '.dsh', 'codebuddy', 'mcp-bridge.log'),
      `${new Date().toISOString()} ${line}\n`)
  } catch { /* 诊断不影响主流程 */ }
}

/** connection 服务面(取实际监听端口)。 */
interface ConnectionFace {
  webServer?: { port?: number }
}

/**
 * 注册 MCP 端点(插件初始化时调用一次;幂等)。
 * @param ctx - 插件上下文(webserver/agents/tools 服务)。
 * @returns 释放函数。
 */
export function registerDshMcpServer(ctx: Context): () => void {
  const injectable = ctx as unknown as {
    inject?: (
      deps: string[],
      fn: (injected: Context) => (() => void) | void,
    ) => { dispose?: () => unknown } | undefined
  }
  // 清扫陈旧配置(进程级一次):每次重启/测试都会因新 key 生成新文件,
  // 只增不删会持续堆积;文件含端点 key,留存越少越好(见实现注释)。
  // 放在 inject 守卫**之前**:清扫与 webServer 是否可用无关,而"只增不删"
  // 恰恰在降级环境(拿不到 inject)下更需要兜住。
  sweepStaleMcpConfigs()
  if (injectable.inject === undefined) return () => {}
  // 回调的返回值是 cordis 的 disposer,会被挂进该 inject 子 fiber:插件卸载/
  // 热重载时自动释放路由。此前把 disposer 存在闭包变量里且无人调用,导致
  // 路由与端点 key 在卸载后仍然存活(泄漏)。
  const fiber = injectable.inject(['webServer'], (injected) => {
    const web = injected.get('webServer') as WebServerFace | undefined
    if (web?.register === undefined) return
    // 端口动态解析:webserver listen 完成前 port 可能是 0——生成配置时现取,
    // 优先 webserver 实际监听值,退 connection 服务,再退 3080。
    const conn = (ctx as unknown as { get: (key: string) => unknown }).get('connection') as ConnectionFace | undefined
    resolvePort = () => {
      const live = web.port
      if (typeof live === 'number' && live > 0) return live
      return conn?.webServer?.port ?? 3080
    }
    const myEndpoint: McpEndpoint = { key: randomBytes(18).toString('hex') }
    endpoint = myEndpoint
    const disposeRoute = web.register({
      kind: 'exact',
      path: DSH_MCP_ENDPOINT_PATH,
      // 兜底 catch:handleMcpRequest 各分支已自带 try/catch,但后续新增分支
      // 一旦抛出,裸 `void` 会变成 unhandled rejection 且请求永久挂起(客户端
      // 只能干等自己的超时)。这里统一收口成 500。
      handler: (req, res) => {
        void handleMcpRequest(ctx, req, res).catch((error: unknown) => {
          console.error('[codebuddy-bridge] MCP 端点未捕获异常:'
            + (error instanceof Error ? error.stack ?? error.message : String(error)))
          try {
            if (!res.writableEnded) {
              res.writeHead(500, { 'content-type': 'text/plain' })
              res.end('internal error')
            }
          } catch { /* 响应已断开:无需再写 */ }
        })
      },
    })
    // 幂等:同一条清理路径可能被触发两次——inject 子 fiber 的自动回收,以及
    // 调用方(ctx.effect)显式释放。实测 fiber.dispose() 可重复调用,这里再加
    // 一道 once 守卫,避免依赖 webserver register 释放函数的幂等性。
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      disposeRoute()
      // 只清自己那一对:避免把后来者的端点/端口解析误清(多实例、热重载)。
      if (endpoint === myEndpoint) {
        endpoint = undefined
        resolvePort = undefined
      }
    }
  })
  // 手动释放面(测试与显式卸载用):释放 inject 子 fiber 即触发上面的 disposer。
  return () => { void fiber?.dispose?.() }
}

/**
 * `--mcp-config` 临时目录(写放大与清扫共用)。
 *
 * 默认系统 temp 下的 `dsh-codebuddy-mcp`;可用环境变量
 * `DSH_CODEBUDDY_MCP_DIR` 覆盖。**测试必须覆盖它**(见
 * `tests/setup-isolate-mcp-dir.ts`):默认目录是**运行中 dsh 服务**正在使用的
 * 真实目录,测试往里写会持续堆积(文件名含每进程随机 key,内容摘要不碰撞),
 * 且 `registerDshMcpServer` 触发的清扫会作用于真实目录。
 */
function mcpConfigDir(): string {
  const override = process.env['DSH_CODEBUDDY_MCP_DIR']
  if (override !== undefined && override.length > 0) return override
  return join(tmpdir(), 'dsh-codebuddy-mcp')
}

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
export function sweepStaleMcpConfigs(dir = mcpConfigDir(), maxAgeMs = 60 * 60 * 1000): number {
  let removed = 0
  try {
    const now = Date.now()
    for (const name of readdirSync(dir)) {
      if (!name.startsWith('mcp-')) continue
      const path = join(dir, name)
      try {
        if (now - statSync(path).mtimeMs > maxAgeMs) {
          rmSync(path, { force: true })
          removed += 1
        }
      } catch { /* 单个文件失败不阻断 */ }
    }
  } catch { /* 目录不存在等:忽略 */ }
  return removed
}

/**
 * 生成会话专属的 `--mcp-config` 文件并返回其路径。
 * @param dshSessionId - 会话 id(URL 携带,端侧据此解析 per-agent 工具集)。
 * @returns 配置文件路径;端点未就绪时 undefined(调用方跳过该参数)。
 */
export function writeDshMcpConfigFile(dshSessionId: string): string | undefined {
  if (endpoint === undefined) return undefined
  const url = `http://127.0.0.1:${resolvePort?.() ?? 3080}${DSH_MCP_ENDPOINT_PATH}`
    + `?session=${encodeURIComponent(dshSessionId)}&key=${endpoint.key}`
  const payload = JSON.stringify({
    mcpServers: {
      [DSH_MCP_SERVER_NAME]: {
        type: 'http',
        url,
        // **全部 dsh 工具直接展开**为 MCP 工具(不延迟加载):模型直接调用
        // mcp__dsh__<工具名>,不再经 ToolSearch / DeferExecuteTool 执行器套壳。
        // 必须显式声明——缺省(false)在 CLI 里会被"全局 defer 开关/产品配置"
        // 覆盖成延迟加载(2026-09-13 实测:未声明时 UI 出现 cli_defer_execute_tool
        // 套壳卡片);显式 false 的优先级高于全局开关。
        defer_loading: false,
      },
    },
  })
  try {
    // 路径含会话与内容摘要:同会话重复 spawn 覆写同一文件,内容变化(如端口)
    // 自动换名,避免读到半旧文件。
    const digest = createHash('sha256').update(payload).digest('hex').slice(0, 8)
    const dir = mcpConfigDir()
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `mcp-${dshSessionId}-${digest}.json`)
    // 0600:文件内含端点 key,默认权限(POSIX 下 0644)会允许同机其他用户读取。
    // Windows 忽略该参数,属无害改进。
    writeFileSync(path, payload, { mode: 0o600 })
    return path
  } catch {
    return undefined
  }
}

/**
 * spawn 参数:bridgeMode **显式等于 `mcp`** 时生成会话专属 MCP 配置并返回
 * `--mcp-config` 参数。
 * @param bridgeMode - 桥接模式(undefined 与 delegate 同义:不注入)。
 * @param dshSessionId - 会话 id(MCP URL 携带,端侧据此解析 per-agent 工具集)。
 * @returns 追加到 CLI argv 的参数(空数组表示不启用 MCP 通道)。
 */
export function mcpConfigArgs(
  bridgeMode: 'mcp' | 'delegate' | undefined,
  dshSessionId: string | undefined,
): string[] {
  // 只有显式 mcp 才注入:undefined 不能再被当作 mcp——低层各处缺省统一按
  // delegate(见 pump.ts this.bridgeMode / serialize 文案),避免"spawn 连了
  // MCP、提示词与注册却按 delegate"的混合态。
  if (bridgeMode !== 'mcp' || dshSessionId === undefined) return []
  const path = writeDshMcpConfigFile(dshSessionId)
  return path === undefined ? [] : ['--mcp-config', path]
}

/** 读取请求体(限长保护)。 */
async function readBody(req: IncomingMessage, limit = 4 * 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > limit) throw new Error('body too large')
    chunks.push(buf)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * 端点 key 校验(常量时间比较)。
 *
 * 长度不等直接判否(长度本身不是秘密),长度相等时用 `timingSafeEqual` 避免
 * 逐字节短路比较泄露前缀信息。144-bit 随机 key + loopback 下时序攻击并不
 * 现实,这属于低成本的纵深防御。
 * @param candidate - URL 上带来的 key(缺失为 null)。
 * @returns 是否匹配当前活跃端点。
 */
function keyMatches(candidate: string | null): boolean {
  if (endpoint === undefined || candidate === null) return false
  const expected = Buffer.from(endpoint.key, 'utf8')
  const actual = Buffer.from(candidate, 'utf8')
  if (expected.length !== actual.length) return false
  return timingSafeEqual(expected, actual)
}

/**
 * MCP 协议版本协商。
 *
 * 客户端报什么就回什么是错的——那等于谎称支持任意版本,把不兼容掩盖到
 * 后续交互里才爆。规范要求服务端回**自己支持的**版本,由客户端决定是否断开。
 * @param requested - initialize 的 protocolVersion(可能缺失或非字符串)。
 * @returns 服务端可用的协议版本。
 */
function negotiateProtocolVersion(requested: unknown): string {
  if (typeof requested === 'string' && MCP_SUPPORTED_PROTOCOL_VERSIONS.includes(requested)) {
    return requested
  }
  if (requested !== undefined) {
    console.error(`[codebuddy-bridge] MCP 协议版本不受支持:客户端=${String(requested)},`
      + `回退到 ${MCP_PROTOCOL_VERSION}`)
  }
  return MCP_PROTOCOL_VERSION
}

/** 单次 MCP 请求处理(JSON-RPC over HTTP,单 JSON 响应)。 */
async function handleMcpRequest(ctx: Context, req: IncomingMessage, res: ServerResponse): Promise<void> {
  // 响应写入统一收口:客户端可能已 abort(见下方 clientGoneAt),对已结束的响应
  // 写入在 Node 里会被静默丢弃(实测不抛异常),这里显式短路以免产生误导日志。
  const fail = (code: number, message?: string): void => {
    if (res.writableEnded || res.destroyed) return
    res.writeHead(code, message === undefined ? {} : { 'content-type': 'text/plain' })
    res.end(message ?? '')
  }
  // 客户端断连时刻:CLI 侧工具调用超时会 abort 本请求,而服务端**不会**因此
  // 中止已注入 loop 的调用(2026-09-13 实测,见 scripts/mcp-abort-probe.mjs)。
  // 记下时刻用于事后留痕——否则"模型报超时、工具其实仍在跑/已跑完"在现场无从
  // 判断,而这条歧义正是重复副作用的温床。必须在首个 await 之前挂上。
  //
  // 它同时是**测量 CLI 侧真实超时**的唯一手段:下面"断连后才完成"的日志会打印
  // 客户端等待时长,那就是实测的 T_client——pump 的 MCP_CALL_TIMEOUT_MS 若要收紧,
  // 必须以这个实测值为依据(不要再拿尾注里的 30s 断言去推)。
  let clientGoneAt: number | undefined
  res.on('close', () => { if (!res.writableFinished) clientGoneAt = Date.now() })
  if (req.method !== 'POST') return fail(405, 'POST only')
  // loopback + key:双重校验(端点只服务本机 CLI 进程)。
  const address = req.socket.remoteAddress ?? ''
  const loopback = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
  if (!loopback) return fail(403, 'loopback only')
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (!keyMatches(url.searchParams.get('key'))) return fail(403, 'bad key')
  const sessionId = url.searchParams.get('session') ?? ''
  let body: string
  try {
    body = await readBody(req)
  } catch {
    return fail(413, 'body too large')
  }
  let msg: { id?: unknown; method?: unknown; params?: Record<string, unknown> }
  try {
    msg = JSON.parse(body) as typeof msg
  } catch {
    return fail(400, 'invalid JSON')
  }
  // 通知(无 id):只回 202。
  if (msg.id === undefined) {
    if (!res.writableEnded && !res.destroyed) res.writeHead(202).end()
    return
  }
  // 响应写入统一收口(与 fail 同guard):客户端断连后写入被静默丢弃,短路掉
  // 可以避免"以为回上了"的错觉,也省掉无谓的序列化。
  const writeJson = (payload: unknown): void => {
    if (res.writableEnded || res.destroyed) return
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(payload))
  }
  const respond = (result: unknown): void => {
    writeJson({ jsonrpc: '2.0', id: msg.id, result })
  }
  const rpcError = (code: number, message: string): void => {
    writeJson({ jsonrpc: '2.0', id: msg.id, error: { code, message } })
  }
  const toolError = (text: string): void => {
    respond({ content: [{ type: 'text', text }], isError: true })
  }
  /** dsh attachments 服务面(图片回传用;缺失即回退纯文本)。 */
  const attachmentsOf = (): AttachmentsReadFace | undefined =>
    (ctx as unknown as { get: (key: string) => unknown }).get('attachments') as AttachmentsReadFace | undefined
  /**
   * 工具结果 → MCP `content` 数组。
   *
   * 含图片且字节可读 → 带 image 块(CLI 侧 `convertMcpResult` 转 `image_url`
   * 交给它自己的模型,与走原生 Read 读图的落点相同);否则回退纯文本单块
   * ——纯文本响应与历史行为逐字一致。
   */
  const contentOf = async (result: DshToolRunResult, text: string): Promise<McpContentPart[]> => {
    const parts = result.content === undefined
      ? undefined
      : await blocksToMcpContent(attachmentsOf(), result.content)
    return parts ?? [{ type: 'text', text }]
  }
  const agentOf = (): Agent | undefined => {
    if (sessionId.length === 0) return undefined
    const agents = (ctx as unknown as { get: (key: string) => unknown }).get('agents') as AgentsFace | undefined
    return agents?.get?.(sessionId) as Agent | undefined
  }
  /**
   * 本会话**可见**的 dsh 工具名集合(与 tools/list 同源)。
   *
   * tools/call 必须按这份名单校验,不能只查命名形态:`isBridgeEligible` 只排
   * 除保留名,不体现 per-agent scope——只用它会让持有 key 的调用方绕过
   * tools/list 的工具面裁剪,调到本会话看不到的工具。
   * @returns 可见工具名;会话无活跃 agent 时 undefined(无从校验 → 一律拒绝)。
   */
  const visibleToolNames = (agent: Agent | undefined): Set<string> | undefined => {
    if (agent === undefined) return undefined
    return new Set(listDshMcpTools(ctx, agent).map(tool => tool.name))
  }
  switch (msg.method) {
    case 'initialize':
      respond({
        protocolVersion: negotiateProtocolVersion(msg.params?.['protocolVersion']),
        capabilities: { tools: {} },
        serverInfo: { name: 'dsh-harness', version: '1.0.0' },
      })
      return
    case 'ping':
      respond({})
      return
    case 'tools/list': {
      const agent = agentOf()
      respond({ tools: agent === undefined ? [] : listDshMcpTools(ctx, agent) })
      return
    }
    case 'tools/call': {
      // 客户端等了多久,一律从这个时刻算起:下面三条诊断都报同一个时钟。
      // `clientGoneAt` 是绝对时刻,拿"某个子阶段开始时刻"去减会得出偏小甚至为负的
      // 数字,而这份日志正是标定 CLI 侧工具超时 T_client 的唯一依据。
      const requestedAt = Date.now()
      const name = msg.params?.['name']
      if (typeof name !== 'string' || !isBridgeEligible(name)) {
        return toolError(`unknown dsh tool: ${String(name)}`)
      }
      // 可见性校验(纵深防御):会话无活跃 agent、或该工具不在本会话工具面内
      // → 拒绝。tools/list 是契约,这里必须与它口径一致。
      const visible = visibleToolNames(agentOf())
      if (visible === undefined) {
        return toolError(`dsh tool "${name}" 不可用:会话 ${sessionId || '(缺失)'} 没有活跃的 agent`)
      }
      if (!visible.has(name)) {
        console.error(`[codebuddy-bridge] MCP tools/call 越权拒绝:session=${sessionId}`
          + ` tool=${name}(不在本会话可见工具面内)`)
        return toolError(`dsh tool "${name}" 对本会话不可见(不在 tools/list 中)`)
      }
      const args = msg.params?.['arguments']
      const input = args !== null && typeof args === 'object' && !Array.isArray(args)
        ? args as Record<string, unknown>
        : {}
      // 优先转发进 dsh loop(原生执行:审批/沙箱/事件/UI 卡片,tool/call 与
      // tool/result 进会话时间线);无活跃回合泵时降级为直接执行。
      const dispatcher = loopDispatchers.get(sessionId)
      if (dispatcher !== undefined) {
        try {
          // 迟到投递口:转发超时后 CLI 收到的是超时错误;工具稍后完成时,
          // 泵经此把真实结果补投回会话(交互式工具全靠它,否则答案永久丢失)。
          // 只投文本:CLI 已按超时放弃,图片块没有可回灌的通道(补投是会话内
          // 记录,不是 MCP 响应)。
          const result = await dispatcher(sessionId, name, input, (lateTool, lateText) => {
            const line = `[codebuddy-bridge] MCP 转发超时后结果补投:session=${sessionId}`
              + ` tool=${lateTool} 工具总耗时=${Date.now() - requestedAt}ms`
            console.error(line)
            bridgeLog(line)
            deliverAfterClientGone(ctx, sessionId, lateTool, lateText, 'dispatch-timeout')
          })
          // 客户端已放弃(CLI 侧超时 abort)但调用确实执行完了:必须留痕——
          // 模型此刻已收到客户端超时错误,可能重试同一命令,而这次注入已经在
          // loop 侧生效。这条日志是排查"副作用跑了两遍"的唯一现场证据,同时
          // 打印的"客户端等待"就是实测的 CLI 侧超时 T_client(校准看门狗用)。
          if (clientGoneAt !== undefined) {
            const line = `[codebuddy-bridge] MCP 调用在客户端断连后才完成:session=${sessionId}`
              + ` tool=${name} 客户端等待=${clientGoneAt - requestedAt}ms(≈CLI 侧超时 T_client)`
              + ` 工具总耗时=${Date.now() - requestedAt}ms`
              + '(模型可能已按超时重试,留意同一副作用重复执行)'
            console.error(line)
            bridgeLog(line)
            // CLI 一定没收到这个响应,所以补投不是重复上报;交互式工具
            // (`ask_user_question` / `exit_plan_mode`)全靠它才有人接着往下走。
            deliverAfterClientGone(ctx, sessionId, name, result.output)
          }
          if (result.isError) return toolError(result.output)
          respond({ content: await contentOf(result, result.output) })
          return
        } catch (error) {
          if (error instanceof McpDispatchTimeoutError) {
            // 兜底触发(注入未被消费 / loop 卡死):**无法确定**工具是否已在 loop
            // 侧执行,故原样回 isError 且**不回落重执**——回落会让同一副作用跑两次。
            const line = `[codebuddy-bridge] MCP 转发兜底超时(不回落重执):session=${sessionId}`
              + ` tool=${name} clientGone=${clientGoneAt !== undefined} err=${error.message}`
            console.error(line)
            bridgeLog(line)
            const advice = `${error.message};为避免同一副作用重复执行,未回落直执——`
              + '请先在会话时间线确认该调用是否已执行,不要盲目重跑同一命令。'
            // 客户端已经走了 → 这句"别重跑"永远到不了模型手里,而它恰恰是防止
            // 重复副作用的关键。补投进会话。
            if (clientGoneAt !== undefined) deliverAfterClientGone(ctx, sessionId, name, advice)
            return toolError(advice)
          }
          // 其余转发失败(回合收尾竞态等):泵不在、工具尚未执行,回落直接执行;
          // 但不静默——这条路径意味着 dsh 侧不会出现对应卡片,留现场日志便于定位。
          const fallbackLine = `[codebuddy-bridge] MCP 转发未成,回落直执:session=${sessionId} tool=${name}`
            + ` err=${error instanceof Error ? error.message : String(error)}`
          console.error(fallbackLine)
          bridgeLog(fallbackLine)
        }
      }
      const result = await runDshBridgeTool(ctx, {
        parentSessionId: sessionId,
        toolName: name,
        input,
      })
      // 直执同样可能比客户端活得久(交互式工具等用户作答):补投,否则
      // 用户在 `ask_user_question` 上答完之后不会有任何后续。
      if (clientGoneAt !== undefined) {
        const line = `[codebuddy-bridge] MCP 直执在客户端断连后才完成:session=${sessionId} tool=${name}`
          + ` 客户端等待=${clientGoneAt - requestedAt}ms 工具总耗时=${Date.now() - requestedAt}ms`
        console.error(line)
        bridgeLog(line)
        deliverAfterClientGone(ctx, sessionId, name, result.output)
      }
      if (result.isError) return toolError(result.output)
      respond({ content: await contentOf(result, result.output) })
      return
    }
    default:
      rpcError(-32601, `method not found: ${String(msg.method)}`)
  }
}
