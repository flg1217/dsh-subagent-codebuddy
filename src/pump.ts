/**
 * 回合泵(路线 C1):**一个 CodeBuddy 回合 = 一个 ACP 进程 = 多个 dsh step**。
 *
 * 背景:CodeBuddy 的回合内部是「模型调用 → 工具执行 → 模型调用 …」的循环,
 * 而 dsh 的 step 语义是「一次模型调用 = 一个 step」。旧实现把整个 CodeBuddy
 * 回合塞进一次 provider 调用(=一个巨型 step),文本/工具顺序、每步统计、
 * 分页、客户端 last-wins 渲染全部错位。
 *
 * 本模块把那个内部循环显式化:
 * - **泵**:进程/握手/prompt 只做一次,持续消费 ACP update,按模型调用切段
 *   (segment);
 * - **attach()**:每个 dsh step 调一次,消费当前段;段在「工具调用边界」收尾
 *   时返回,agent-loop 于是写原生 `assistant/message` + `tool/call`,并调用
 *   本模块注册的**回放工具**执行工具调用——回放工具只等 ACP 报来的结果,
 *   由 loop 写原生 `tool/result`;随后 loop 开下一个 step,attach() 消费下一段;
 * - **收尾**:最后一段(无工具调用)在 tail 窗口结束后返回,loop 以
 *   `completed` 闭合回合。
 *
 * 边界识别(实测 cb-segment-probe.mjs):
 * - 工具调用以 `tool_call`(in_progress,参数流式)→ `tool_call`(pending,
 *   `toolArgumentsComplete=true`,全参)出现;`tool_call_update`(completed/failed)
 *   带结果;
 * - 模型调用结束的信号:`agentPhase` → `tool_executing`,或首个工具结果到达,
 *   或静默兜底(老 CLI 无 phase);
 * - `usage_update` 每次模型调用一条,在工具开始执行后 ~100ms 到;收段前给它
 *   一个短宽限期,保证每段带上自己的用量。
 * @module subagent-codebuddy/pump
 */

import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { AcpConnection, DEFAULT_ACP_RUN_TIMEOUTS, isProgressUpdate, toolNameOf, usageOfUpdate } from './acp.js'
import type { AcpClientRequest, AcpPromptResult, AcpTimeouts, AcpUpdate } from './acp.js'
import { agentIdFromOutput, SubagentMirror } from './mirror.js'
import { foldPendingInsertions } from './inbox.js'
import { todoToolKind } from './todo-bridge.js'
import type { TodoListState } from './todo-bridge.js'
import { failureOfError, formatFailureLine, isFailureOutcome, parseCodebuddyFailure } from './failure.js'
import { imageReadAlias, toolResultBlocksFromText } from './tool-image.js'
import type { AttachmentsSaveFace } from './tool-image.js'
import { announceDelegateTools, DELEGATE_TOOL_METHOD } from './delegate.js'
import { bridgeTargetTool, CLI_MIRROR_TOOL_PREFIX, listDshBridgeTools, runDshBridgeTool } from './dsh-tools-bridge.js'
import { syncCliIntegrations } from './cli-integrations.js'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** 工具结果(ACP 报来的原始形态)。 */
interface ToolOutcome {
  text: string
  isError: boolean
}

/** 一次工具调用的泵内状态。 */
interface CallState {
  id: string
  /** CodeBuddy 原始工具名(镜像/别名判定用)。 */
  rawName: string
  /** 落地进 dsh 事件的名字(归一化 + 图片别名)。 */
  dshName: string
  argsJson: string
  /** 是否已向段内发射 tool-call 块(参数完整后才发射)。 */
  announced: boolean
  /** read_image 别名调用的 meta 路径。 */
  imagePath?: string
  outcome?: ToolOutcome
  waiting: Array<{
    resolve: (outcome: ToolOutcome) => void
    reject: (error: Error) => void
  }>
}

/** 一段 = 一次模型调用(文本/思考块 + 工具调用)。 */
interface Segment {
  chunks: StreamChunk[]
  cursor: number
  /** 本段内参数完整的工具调用 id。 */
  calls: string[]
  usage?: TokenUsage
  closed: boolean
  /** 收段原因:tools=工具边界(还有下一段);settle=回合收尾。 */
  outcome: 'tools' | 'settle'
  /** 已发射的块计数(块索引分配)。 */
  blockIndex: number
  /** 当前打开的文本/思考块(收段前闭合)。 */
  open?: { kind: 'text' | 'reasoning'; index: number; messageId: string; text: string }
}

/** 会话面(todo 折叠/插话轮询需要 ownEvents;todo 快照写入需要 append)。 */
export interface PumpSessionFace {
  ownEvents?: () => readonly { type: string; data?: unknown }[]
  append?: (type: string, data: unknown) => unknown
}

/** 泵的宿主依赖(由 adapter 提供;避免与 adapter.ts 形成运行时循环)。 */
export interface PumpHost {
  ctx: Context
  command: string
  prefixArgs: string[]
  extraArgs: string[]
  /** 推理强度(--effort;未选则不传,保持 CLI 默认)。 */
  reasoningEffort?: string
  timeouts?: AcpTimeouts
  maxAttempts?: number
  retryDelayMs?: number
  steerPollMs?: number
  nativeBaseDir?: string
  /** dsh 会话 id(泵的键,也是回放工具注册的 scope)。 */
  dshSessionId: string
  model: string
  cwd: string
  acpCwd: string
  /** 已有 CodeBuddy 会话(load 复用);否则 session/new。 */
  resume?: { acpId: string }
  prompt: string
  images: Array<{ data: string; mimeType: string }>
  /** load 失败时回退:完整历史重发的提示词。 */
  fallbackPrompt: () => Promise<{ prompt: string; images: Array<{ data: string; mimeType: string }> }>
  /** 会话登记(续接锚点:sentCount = 本次发送时 dsh 消息总数;lastMessageId = 本次覆盖到的最后一条消息)。 */
  rememberConversation: (acpId: string, sentCount: number, lastMessageId?: string) => void
  /** 本次发送覆盖到的最后一条消息 id(补发主锚,写回续接记录)。 */
  sentLastMessageId?: string
  /** 登记失效(CodeBuddy 侧会话丢失)。 */
  forgetConversation: () => void
  sentCount: number
  session?: PumpSessionFace
  /** 子会话 header(镜像用)。 */
  childSession?: { header?: { agentPreset?: string; delegationDepth?: number } }
  attachmentsOf: () => AttachmentsSaveFace | undefined
  /** 本会话的 todo 折叠状态(跨回合复用;无则 undefined)。 */
  todoStateOf: () => TodoListState | undefined
  /** 转发 id 标记(next-step 插话);已标记过返回 false。 */
  markForwarded: (id: string) => boolean
}

/** 仅供测试:清空模块级注册表并释放残留的泵(跨用例隔离)。 */
export function resetPumpStateForTests(): void {
  for (const pump of livePumps.values()) pump.dispose()
  livePumps.clear()
  registeredReplayTools.clear()
}

/**
 * 回放工具的 presentationMeta 投影:只透传显式 meta(无损 JSON 对象),
 * 缺失/非法一律给 `{}`。
 *
 * dsh 的工具框架对投影结果做无损 JSON 快照——返回 `undefined` 会被判
 * `INVALID_TOOL_OUTPUT` 并把**真实工具结果整个吞掉**(实测:委托工具的子代理
 * 输出因此变成 "returned invalid output",模型只看到报错)。
 * @param value - 回放工具返回值(`{ blocks, meta? }`)。
 * @returns 可快照的投影元数据(至少是空对象)。
 */
export function replayPresentationMeta(value: unknown): Record<string, JsonValue> {
  const meta = (value as { meta?: unknown } | null | undefined)?.meta
  return meta !== null && typeof meta === 'object' && !Array.isArray(meta)
    ? meta as Record<string, JsonValue>
    : {}
}

/** 活跃泵:回放工具经此找到当前回合。 */
const livePumps = new Map<string, TurnPump>()
/** 已注册的回放工具(sessionId → 工具名集合;per-agent 注册只需一次)。 */
const registeredReplayTools = new Map<string, Set<string>>()

/** 段收尾后的 usage 宽限期(毫秒):等本次模型调用的用量样本归段。 */
const USAGE_GRACE_MS = 700
/** 工具边界静默兜底(毫秒):无 phase 信号的老 CLI 用它判定模型调用结束。 */
const BOUNDARY_QUIET_MS = 1_000
/** 泵心跳间隔(毫秒):steer 轮询 / 看门狗 / 收段判定共用。 */
const TICK_MS = 100
/**
 * dsh 发起的调用的固定尾注(附在每条 prompt 末端)。
 *
 * CodeBuddy CLI 自带子代理体系(Task/Agent 团队)与自带后台任务(bash
 * run_in_background / docker exec -d),而这条链路里它是被 dsh 拉起的模型
 * 后端:子任务必须交给 dsh 的子代理(委托工具 `dsh_subagent`),长命令必须
 * 走 `dsh_bash`——只有 dsh 通道的任务会进会话树/后台面板,并在完成时唤起
 * 下一轮。尾注同时声明"回合结束后不会自动恢复"的落点:否则模型会承诺
 * "等 X 完成后继续汇报",而外部任务没有完成事件,用户只能主动催。
 * 位置固定在末尾——模型对最新一条输入的尾部指令最敏感。
 */
export const DSH_DELEGATION_NOTE = [
  '[dsh 运行环境]',
  '本次调用由 dsh 框架发起:你(CodeBuddy)作为 dsh 的模型后端运行。',
  '本会话的全部 dsh 工具都以 DelegateTool 的 toolId="dsh_<原工具名>" 注册(常见:dsh_bash、dsh_subagent、dsh_read、dsh_grep)——它们在 dsh 侧执行(受沙箱/审批约束、进会话日志与审计):',
  '- 知道工具名就直接用 dsh_<原工具名> 调用;绝不要发空的 DelegateTool 调用(delegate_tool {})来"枚举工具"——它会挂起整个回合且不会有任何返回。不确定某个工具是否存在时,直接按原工具名加 dsh_ 前缀试即可。',
  '- 优先用 dsh_* 工具,不要用 CLI 自带的同类工具——CLI 内置工具的结果不进 dsh。',
  '- 长命令(构建/测试/对战模拟/服务等可能跑几分钟的):dsh_bash 必须带 run_in_background:true——任务进侧栏"后台任务",完成时会自动通知并唤醒你继续。绝不要用 CLI 自己的后台方式(bash 的 run_in_background、docker exec -d、自写轮询脚本):它们不进 dsh——面板不显示、完成收不到,回合结束后对话显示"已完成"而任务还在跑,用户只能来催你。',
  '- 沙箱拒绝不绕行:dsh_bash 报 [sandbox: file access denied ...] 时,不要改用 CLI 自带工具执行同一命令绕过沙箱;按工具描述用 sandbox_permissions + justification 走提权审批(审批弹窗即用户同意);被拒或会话禁用审批时即为最终结果,不要换路重试。',
  '- 委派子任务:先 dsh_list_subagent_models 查可用路由,再用 dsh_subagent 委派(默认后台;结算通知会唤醒你);继续同一子代理用 dsh_send_message(input.childId)。不要用 CLI 自带的 agent/Task 工具。',
  '- 你的回合结束后不会自动恢复:不要承诺"等 X 完成后我再汇报/继续"——只有走 dsh 通道的任务会在完成时唤醒你;确实必须用外部方式时,请在回复里如实告诉用户"跑完后需要你叫我一声"。',
].join('\n')

/** 每条 prompt 的固定尾注:空行 + dsh 运行环境说明。 */
const PROMPT_TAIL = '\n\n' + DSH_DELEGATION_NOTE

/** 重启跨 attempt 保留的执行状态(重试是同一任务的延续,已学到的间隔不丢)。 */
export interface PumpStepState {
  mirroredCalls: Set<string>
  maxGapMs: number
}

/**
 * 一个 CodeBuddy 回合的 ACP 泵。生命周期 = 从首次 provider 调用到回合收尾
 * (含 tail 窗口);期间 provider 可被调用多次(每个 dsh step 一次)。
 */
export class TurnPump {
  private conn: AcpConnection | undefined
  private acpSessionId = ''
  private capturing = true
  private readonly deps: PumpHost
  private readonly to: typeof DEFAULT_ACP_RUN_TIMEOUTS & AcpTimeouts
  private readonly maxAttempts: number
  private readonly retryDelayMs: number
  private readonly steerPollMs: number
  private readonly boundaryQuietMs: number
  private readonly usageGraceMs: number
  private readonly stepState: PumpStepState

  private attempts = 0
  /** 段队列:进行中/已完成的模型调用段(attach 顺序消费)。 */
  private segments: Segment[] = []
  private readonly calls = new Map<string, CallState>()
  /** 本回合是否起过后台任务(工具参数 run_in_background/background)。 */
  private backgroundLaunched = false
  /** 是否产出过文本(静默失败判定:块可能尚未闭合)。 */
  private hasText = false
  private finished = false
  private failed: Error | undefined
  private disposed = false

  /** 看门狗状态(与旧直写实现同一套动态预算)。 */
  private lastProgressAt = Date.now()
  private progressSamples = 0
  private maxGapMs = 0
  private lastBudgetMs: number
  private stallTimedOut = false
  private killTimer: ReturnType<typeof setTimeout> | undefined
  private cancelLoopTimer: ReturnType<typeof setInterval> | undefined

  /** 尾巴窗口状态。 */
  private promptSettled = false
  private stopReason: string | undefined
  private inFlight = 0
  private promptError: Error | undefined
  /** prompt 结果里的失败分类(refusal + _meta errorMessage/outcome)。 */
  private promptFailure: import('./failure.js').CodebuddyFailure | undefined
  private agentPhaseSeen = false
  private sessionEnded = false
  private lastUpdateAt = Date.now()
  private lastContentAt = 0
  private tailStartAt: number | undefined
  private tailDeadline: number | undefined
  /** CLI 报"空闲"相位的时间(agentPhase=idle);undefined = 本轮未报过。 */
  private lastIdlePhaseAt: number | undefined
  /** 最近一次"工具执行中"相位的时间(它算活动;session_info 心跳不算)。 */
  private lastToolExecutingAt = 0

  /** 收段判定辅助。 */
  private boundarySeenAt = 0
  /** 边界/收尾的一次性补判定定时器(心跳粒度不够时的精确收口)。 */
  private checkTimer: ReturnType<typeof setTimeout> | undefined
  private usageGraceUntil = 0
  private toolExecutingSeen = false
  private firstResultSeen = false

  /** steer 轮询。 */
  private lastSteerPoll = 0

  /** 子代理镜像 / todo 桥。 */
  private readonly mirrors = new Map<string, SubagentMirror>()
  private readonly subagentCallIds = new Set<string>()

  private readonly tickTimer: ReturnType<typeof setInterval>
  private wake: (() => void) | undefined
  /** 外部 abort(agent-loop 的回合信号)。 */
  private readonly onAbort = (): void => {
    if (this.acpSessionId !== '') this.conn?.notify('session/cancel', { sessionId: this.acpSessionId })
    this.cancelLoopTimer ??= setInterval(() => {
      if (this.acpSessionId !== '') this.conn?.notify('session/cancel', { sessionId: this.acpSessionId })
    }, 1_000)
    // 消费方(当前 step 的 stream)会自行收尾并释放;但若 abort 落在两次
    // provider 调用之间(上一步已返回、下一步还没开),没有消费方负责释放——
    // 宽限一会儿自行收掉,避免进程/回放工具悬挂到看门狗硬顶。
    const timer = setTimeout(() => this.dispose(), 1_000)
    timer.unref?.()
    this.wakeAll()
  }

  constructor(deps: PumpHost, private readonly signal: AbortSignal | undefined, stepState: PumpStepState) {
    this.deps = deps
    this.stepState = stepState
    this.to = { ...DEFAULT_ACP_RUN_TIMEOUTS, ...deps.timeouts }
    this.maxAttempts = deps.maxAttempts ?? 2
    this.retryDelayMs = deps.retryDelayMs ?? 3_000
    this.steerPollMs = deps.steerPollMs ?? 1_200
    this.boundaryQuietMs = this.to.boundaryQuietMs ?? BOUNDARY_QUIET_MS
    this.usageGraceMs = this.to.usageGraceMs ?? USAGE_GRACE_MS
    this.lastBudgetMs = this.to.idleMaxMs
    livePumps.set(deps.dshSessionId, this)
    this.tickTimer = setInterval(() => this.tick(), TICK_MS)
    this.tickTimer.unref?.()
    signal?.addEventListener('abort', this.onAbort, { once: true })
    // 常驻任务表重播:CodeBuddy 任务列表跨回合常驻,dsh 的 todos 投影在每个
    // turn/start 清空——回合开头重写一份当前快照,面板跨回合继续显示同一计划。
    this.replayTodos()
    void this.runAttempt() // 首段:握手 + prompt
  }

  /** 回放工具 → 当前泵(未在跑/已收尾时为 undefined)。 */
  static forSession(sessionId: string): TurnPump | undefined {
    return livePumps.get(sessionId)
  }

  /** 回合是否已被调用方中止(abort 交给 loop 的中断语义收尾)。 */
  private get aborted(): boolean { return this.signal?.aborted === true }

  // ── 消费面(provider stream)────────────────────────────────────────────

  /**
   * 附加到本回合的下一段:顺序吐出该段的 chunk;段在工具边界或回合收尾处返回。
   * 每个 dsh step 调一次。abort 直接返回(由 loop 的中断语义收尾)。
   */
  async *attach(): AsyncGenerator<StreamChunk> {
    for (;;) {
      if (this.aborted) return
      const segment = this.segments[0]
      if (segment !== undefined) {
        while (segment.cursor < segment.chunks.length) yield segment.chunks[segment.cursor++]!
        if (!segment.closed) { await this.waitEvent(); continue }
        this.segments.shift()
        if (this.failed !== undefined) { yield* this.yieldError(this.failed); return }
        yield {
          type: 'finish',
          reason: segment.outcome === 'settle' && this.isMaxTokens() ? { kind: 'max-tokens' } : { kind: 'stop' },
        }
        return
      }
      if (this.failed !== undefined) { yield* this.yieldError(this.failed); return }
      if (this.finished) { yield { type: 'finish', reason: { kind: 'stop' } }; return }
      await this.waitEvent()
    }
  }

  /**
   * 以 finish error 收尾(而非抛出):让 agent-loop 走它自己的
   * `agent/request-error` 路径——消息进 LlmError、回合以错误闭合,
   * 与一次性路径的中断语义一致(可重试与否已在泵内决定)。
   */
  private async *yieldError(error: Error): AsyncGenerator<StreamChunk> {
    yield {
      type: 'finish',
      reason: {
        kind: 'error',
        failure: { message: error.message.slice(0, 500), code: 'CODEBUDDY_EXEC_ERROR' },
      },
    }
  }

  private isMaxTokens(): boolean {
    const stop = this.stopReason?.toLowerCase()
    return stop === 'max_tokens' || stop === 'max-tokens'
  }

  // ── 回合生命周期 ───────────────────────────────────────────────────────

  /** 起一次 ACP 进程 + 握手 + prompt(重启路径也走它)。 */
  private async runAttempt(): Promise<void> {
    if (this.disposed || this.aborted) return
    this.attempts += 1
    this.capturing = true
    this.promptSettled = false
    this.stopReason = undefined
    this.promptError = undefined
    this.promptFailure = undefined
    this.toolExecutingSeen = false
    this.firstResultSeen = false
    this.boundarySeenAt = 0
    this.usageGraceUntil = 0
    this.sessionEnded = false
    this.tailStartAt = undefined
    this.tailDeadline = undefined
    this.lastIdlePhaseAt = undefined
    this.lastToolExecutingAt = 0

    // 参数与旧实现逐字一致(实测过的组合):`--dangerously-skip-permissions`
    // 而非 `--permission-mode`——后者虽是配置项,但从未在此路径生效,不顺手改
    // 行为(改权限参数等于换一套 CLI 行为,需要单独实测)。
    const argv = [
      this.deps.command,
      ...this.deps.prefixArgs,
      '--acp',
      '--model',
      this.deps.model,
      ...this.deps.reasoningEffort === undefined ? [] : ['--effort', this.deps.reasoningEffort],
      '--dangerously-skip-permissions',
      ...this.deps.extraArgs,
    ]
    // CLI 进程将在启动时读取 ~/.codebuddy/mcp.json 与 skills 目录:每次
    // 启动前同步一次(dsh 的 MCP 配置 / skills → CLI 原生通道),保证最新。
    syncCliIntegrations({ projectCwd: this.deps.cwd })
    const conn = new AcpConnection(
      argv,
      this.deps.cwd,
      update => this.onUpdate(update),
      request => this.handleClientRequest(request),
    )
    this.conn = conn
    conn.onExit(info => {
      if (conn.wasKilled || this.stallTimedOut || this.disposed) return
      // 进程退出沿用旧语义:不可续跑(重试会重复已完成部分),显式中止。
      this.failRun(new Error(
        `CodeBuddy ACP 进程退出(code ${info.code ?? 'null'}${info.signal !== null ? `,signal ${info.signal}` : ''})${conn.stderrNote()}`,
      ), false)
    })

    try {
      await conn.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      }, this.to.firstMs)

      if (this.deps.resume !== undefined) {
        try {
          await conn.request('session/load', { sessionId: this.deps.resume.acpId, cwd: this.deps.acpCwd, mcpServers: [] })
          this.acpSessionId = this.deps.resume.acpId
        } catch {
          // CodeBuddy 侧会话存储丢失:回退新会话 + 完整历史重发。
          this.deps.forgetConversation()
          this.deps.resume = undefined
          const full = await this.deps.fallbackPrompt()
          this.deps.prompt = full.prompt
          this.deps.images = full.images
          const created = await conn.request<{ sessionId: string }>('session/new', { cwd: this.deps.acpCwd, mcpServers: [] }, this.to.firstMs)
          this.acpSessionId = created.sessionId
        }
      } else {
        const created = await conn.request<{ sessionId: string }>('session/new', { cwd: this.deps.acpCwd, mcpServers: [] }, this.to.firstMs)
        this.acpSessionId = created.sessionId
      }
      this.deps.rememberConversation(this.acpSessionId, this.deps.sentCount, this.deps.sentLastMessageId)
      // 统一委托面:当前会话可见的全部 dsh 工具以 `dsh_<原名>` 注册为
      // CodeBuddy 的 delegate tools(含 bash/subagent——原生本就是后台任务
      // 与可续用子代理);调用经 dsh 官方工具管线执行(审批/沙箱/事件一致)。
      // MCP 工具走 CLI 原生 MCP 通道、Skill 走 CLI 的 skill 目录,都不在此列。
      // 分批注册:数量上限未知,单批失败不影响其余批次与会话基本功能。
      const parentAgent = this.deps.ctx.get('agents')?.get(this.deps.dshSessionId as SessionId)
      const bridgeTools = parentAgent === undefined
        ? []
        : listDshBridgeTools(this.deps.ctx, parentAgent)
      const BRIDGE_BATCH = 20
      for (let offset = 0; offset < bridgeTools.length; offset += BRIDGE_BATCH) {
        void announceDelegateTools(
          (method, params) => conn.request(method, params, this.to.firstMs),
          this.acpSessionId,
          bridgeTools.slice(offset, offset + BRIDGE_BATCH),
        ).catch(() => { /* 该批注册失败:其余批次仍在 */ })
      }
      this.capturing = false
      this.sendPrompt(this.deps.prompt, this.deps.images)
      this.armProgress()
    } catch (error) {
      if (this.aborted || this.disposed) return
      this.failRun(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private sendPrompt(prompt: string, images: Array<{ data: string; mimeType: string }>): void {
    const conn = this.conn
    if (conn === undefined) return
    this.inFlight += 1
    this.promptSettled = false
    void conn.request<AcpPromptResult>(
      'session/prompt',
      {
        sessionId: this.acpSessionId,
        prompt: [
          { type: 'text', text: prompt + PROMPT_TAIL },
          ...images.map(image => ({ type: 'image', data: image.data, mimeType: image.mimeType })),
        ],
      },
      0,
    ).then(
      value => {
        this.stopReason = value.stopReason
        // 失败详情优先取顶层 errorMessage;refusal 场景只有
        // `_meta["codebuddy.ai/errorMessage"]`(JSON:code/category/statusCode/
        // displayMsg)与 `codebuddy.ai/outcome`(FAILED_MODEL_REQUEST 等)。
        const metaError = value._meta?.['codebuddy.ai/errorMessage']
        const metaOutcome = value._meta?.['codebuddy.ai/outcome']
        const raw = value.errorMessage !== undefined && value.errorMessage.length > 0
          ? value.errorMessage
          : (typeof metaError === 'string' ? metaError : undefined)
        const outcome = isFailureOutcome(metaOutcome) ? metaOutcome : undefined
        if (raw !== undefined || outcome !== undefined) {
          this.promptFailure = parseCodebuddyFailure(raw, undefined, outcome)
        }
      },
      error => {
        this.promptError = error instanceof Error ? error : new Error(String(error))
      },
    ).finally(() => {
      this.inFlight -= 1
      if (this.promptError === undefined && this.promptFailure === undefined) this.promptSettled = true
      this.wakeAll()
    })
  }

  /** 回合收尾:断开进程、清空活跃表、唤醒所有等待者。 */
  private finishTurn(): void {
    if (this.finished) return
    this.finished = true
    // 只摘自己:上一回合的泵迟到收尾时,同 id 的新回合泵可能已经登记。
    if (livePumps.get(this.deps.dshSessionId) === this) livePumps.delete(this.deps.dshSessionId)
    this.dispose()
  }

  /** 失败:首段无产出 → 重启;否则整体失败(消费方抛出,loop 收错误回合)。 */
  private failRun(error: Error, retryable = true): void {
    if (this.finished || this.disposed) return
    if (this.canRestart(retryable)) { this.restart(); return }
    this.failed = error
    for (const segment of this.segments) {
      if (!segment.closed) {
        this.closeOpenBlock(segment)
        segment.closed = true
      }
    }
    for (const call of this.calls.values()) {
      for (const waiter of call.waiting.splice(0)) waiter.reject(error)
    }
    this.finishTurn()
    this.wakeAll()
  }

  /** 重启资格:失败可续跑、仍是首段、本回合无任何产出、还有重试次数。 */
  private canRestart(retryable: boolean): boolean {
    return retryable
      && this.attempts < this.maxAttempts
      && !this.hasText
      && this.calls.size === 0
      && !this.aborted
  }

  private restart(): void {
    this.disposeProcess()
    this.capturing = true
    // 已登记的 CodeBuddy 会话继续复用之(避免重试丢历史)。
    if (this.acpSessionId !== '') this.deps.resume = { acpId: this.acpSessionId }
    this.acpSessionId = ''
    this.promptError = undefined
    this.promptFailure = undefined
    this.stallTimedOut = false
    this.lastProgressAt = Date.now()
    this.segments = []
    this.backgroundLaunched = false
    const timer = setTimeout(() => { void this.runAttempt() }, this.retryDelayMs)
    timer.unref?.()
    this.wakeAll()
  }

  /** 补一次「到期即判定」的定时器(收段宽限/尾巴静默预算)。 */
  private armCheck(delayMs: number): void {
    if (this.checkTimer !== undefined) clearTimeout(this.checkTimer)
    const timer = setTimeout(() => {
      this.checkTimer = undefined
      this.tick()
    }, Math.max(5, delayMs))
    timer.unref?.()
    this.checkTimer = timer
  }

  /** 释放进程与计时器(幂等;不改变 finished 状态)。 */
  private disposeProcess(): void {
    if (this.checkTimer !== undefined) { clearTimeout(this.checkTimer); this.checkTimer = undefined }
    if (this.killTimer !== undefined) { clearTimeout(this.killTimer); this.killTimer = undefined }
    if (this.cancelLoopTimer !== undefined) { clearInterval(this.cancelLoopTimer); this.cancelLoopTimer = undefined }
    try { this.conn?.kill() } catch { /* 已退出 */ }
    this.conn = undefined
  }

  /** 整体收尾:释放一切,唤醒等待者。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    // 摘掉自己的登记:否则已释放的泵会遮蔽同会话下一回合的新泵。
    if (livePumps.get(this.deps.dshSessionId) === this) livePumps.delete(this.deps.dshSessionId)
    clearInterval(this.tickTimer)
    this.signal?.removeEventListener('abort', this.onAbort)
    // 未完成的工具调用:拒绝所有等待者,避免回放工具悬挂。
    for (const call of this.calls.values()) {
      for (const waiter of call.waiting.splice(0)) waiter.reject(new Error('CodeBuddy 回合已结束'))
    }
    for (const mirror of this.mirrors.values()) void mirror.finish()
    this.mirrors.clear()
    this.disposeProcess()
    this.wakeAll()
  }

  // ── 回放工具 ───────────────────────────────────────────────────────────

  /**
   * 等一次工具调用的结果(回放工具的 execute 调用面)。
   * 结果文本截断 2000 字符(与旧直写路径一致);图片结果转 attachment 内容块,
   * 避免 base64 进会话。
   */
  async awaitResult(callId: string, signal?: AbortSignal): Promise<{ blocks: ContentBlock[]; meta?: unknown }> {
    const call = this.calls.get(callId)
    if (call === undefined) throw new Error(`CodeBuddy: 未知的工具调用 ${callId}(该调用不属于当前回合)`)
    // 已中止的调用方不再登记等待者:否则要等回合收尾的兜底才失败。
    if (call.outcome === undefined && signal?.aborted === true) throw new Error('tool call aborted')
    const outcome = call.outcome ?? await new Promise<ToolOutcome>((resolve, reject) => {
      call.waiting.push({ resolve, reject })
      signal?.addEventListener('abort', () => {
        const index = call.waiting.findIndex(waiter => waiter.resolve === resolve)
        if (index >= 0) call.waiting.splice(index, 1)
        reject(new Error('tool call aborted'))
      }, { once: true })
    })
    if (outcome.isError) throw new Error(outcome.text.slice(0, 2000))
    let blocks: ContentBlock[] = [{ type: 'text', text: outcome.text.slice(0, 2000) }]
    const converted = await toolResultBlocksFromText(this.deps.attachmentsOf(), outcome.text, call.imagePath)
    if (converted !== undefined) blocks = converted as unknown as ContentBlock[]
    return { blocks, ...(call.imagePath === undefined ? {} : { meta: { path: call.imagePath } }) }
  }

  /** 为此 agent 注册一个回放工具(同名工具名只注册一次)。 */
  private ensureReplayTool(name: string): void {
    const sessionId = this.deps.dshSessionId
    let names = registeredReplayTools.get(sessionId)
    if (names === undefined) {
      names = new Set()
      registeredReplayTools.set(sessionId, names)
    }
    if (names.has(name)) return
    names.add(name)
    try {
      const agents = (this.deps.ctx as unknown as { get?: (key: string) => unknown }).get?.('agents') as
        | { get?: (id: string) => { ctx?: unknown } | undefined }
        | undefined
      const agent = agents?.get?.(sessionId)
      const tools = (agent?.ctx as { get?: (key: string) => unknown } | undefined)?.get?.('tools') as
        | { register?: (definition: unknown) => unknown }
        | undefined
      if (tools?.register === undefined) return
      tools.register(defineTool({
        name,
        description: `“${name}” was executed by the CodeBuddy CLI on this session; this tool records`
          + ' the CLI-reported outcome back into the conversation.',
        parameters: {},
        output: {
          // 值 = { blocks: ContentBlock[], meta?: JSON }:内容由 CLI 输出转换而来,
          // 形态不由 dsh 约束(不透明重放),用 json 逃生口。
          schema: { type: 'json' },
          render: (_args, value) => (value as unknown as { blocks: ContentBlock[] }).blocks,
          presentationMeta: (_args, value) => replayPresentationMeta(value),
        },
        isConcurrencySafe: () => true,
        execute: async (_args, exec) => {
          const pump = TurnPump.forSession(sessionId)
          if (pump === undefined) {
            throw new Error('CodeBuddy: 该会话当前没有运行中的 CodeBuddy 回合(模型可能已切换)')
          }
          return await pump.awaitResult(exec.callId, exec.signal) as unknown as never
        },
      }))
    } catch { /* 重复注册/服务缺失:不影响对话 */ }
  }

  // ── CLI → 客户端的请求(extMethod)─────────────────────────────────────

  /**
   * CLI 发来的方法请求:统一入口——`dsh_<工具名>` 的委托工具执行。
   * 返回 undefined 表示本客户端不支持该方法(AcpConnection 会回 -32601)。
   */
  private async handleClientRequest(request: AcpClientRequest): Promise<unknown | undefined> {
    if (request.method !== DELEGATE_TOOL_METHOD) return undefined
    const toolId = typeof request.params['toolId'] === 'string' ? request.params['toolId'] : ''
    const raw = request.params['input']
    const input = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? raw as Record<string, unknown>
      : {}
    // 空 toolId(空 DelegateTool 调用的"枚举试探"):回工具清单而不是错误。
    // CLI 对空调用通常会挂起不转发;万一转发到客户端,明确的清单能让模型
    // 的试探得到答案(而不是一个语焉不详的错误)。
    if (toolId.length === 0) {
      const parent = this.deps.ctx.get('agents')?.get(this.deps.dshSessionId as SessionId)
      const ids = parent === undefined ? [] : listDshBridgeTools(this.deps.ctx, parent).map(tool => tool.id)
      return {
        status: 'success',
        output: ids.length > 0
          ? `Available dsh tools (call via DelegateTool toolId=<id>):\n${ids.join('\n')}`
          : 'No dsh tools are currently available in this session.',
      }
    }
    // 统一桥:`dsh_<工具名>` → dsh 官方工具管线执行(审批/沙箱/事件与原生一致)。
    const bridged = bridgeTargetTool(toolId)
    if (bridged !== undefined) {
      return await runDshBridgeTool(this.deps.ctx, {
        parentSessionId: this.deps.dshSessionId,
        toolName: bridged,
        input,
        ...(this.signal === undefined ? {} : { signal: this.signal }),
      })
    }
    return { status: 'error', error: { message: `unknown delegate tool: ${JSON.stringify(toolId)}` } }
  }

  // ── update 处理(同步状态机)────────────────────────────────────────────

  private onUpdate(update: AcpUpdate): void {
    if (this.capturing || this.disposed) return
    this.applyUpdate(update)
    // 事件驱动的收段判定:边界信号(phase=tool_executing / 工具结果)一到就
    // 收口,不等心跳——否则下一段内容可能漏进上一段(实测:慢心跳 + 快速续跑)。
    this.checkSegmentBoundary()
  }

  /** 单条 update 的状态机(不触发收段判定)。 */
  private applyUpdate(update: AcpUpdate): void {
    this.lastUpdateAt = Date.now()
    const kind = update.sessionUpdate
    if (kind === 'session_info_update') {
      const phase = (update._meta?.['codebuddy.ai/agentPhase'] as { phase?: unknown } | undefined)?.phase
      if (typeof phase === 'string') {
        this.agentPhaseSeen = true
        if (phase === 'tool_executing') {
          this.toolExecutingSeen = true
          this.lastToolExecutingAt = Date.now()
        }
        if (phase === 'idle') this.lastIdlePhaseAt = Date.now()
      }
    } else if (kind === 'session_end') {
      this.sessionEnded = true
    }
    if (isProgressUpdate(update)) {
      this.lastContentAt = Date.now()
      this.armProgress()
    }
    switch (kind) {
      case 'agent_thought_chunk':
      case 'agent_message_chunk': {
        const text = update.content?.text ?? ''
        if (text.length === 0) return
        const blockKind = kind === 'agent_thought_chunk' ? 'reasoning' : 'text'
        const messageId = update.messageId ?? `${blockKind}-anonymous`
        const segment = this.openSegment()
        if (segment.open === undefined || segment.open.kind !== blockKind || segment.open.messageId !== messageId) {
          this.closeOpenBlock(segment)
          const index = segment.blockIndex++
          segment.open = { kind: blockKind, index, messageId, text: '' }
          segment.chunks.push({ type: 'block-start', index, blockType: blockKind })
        }
        if (blockKind === 'text') this.hasText = true
        segment.open.text += text
        segment.chunks.push({
          type: blockKind === 'reasoning' ? 'reasoning-delta' : 'text-delta',
          index: segment.open.index,
          text,
        })
        this.wakeAll()
        return
      }
      case 'usage_update': {
        const sample = usageOfUpdate(update)
        if (sample === undefined) return
        // 归段:当前未收尾的段(收段前等 usage 的宽限期依赖它);样本同时作为
        // chunk 交给 loop,统计/上下文占用才有数(assembler 取流内末位样本)。
        const segment = this.openSegment()
        segment.usage = sample
        segment.chunks.push({ type: 'usage', usage: sample })
        this.wakeAll()
        return
      }
      case 'tool_call': {
        if (update.toolCallId === undefined) return
        if (update._meta?.['codebuddy.ai/isSubagent'] === true) this.subagentCallIds.add(update.toolCallId)
        const complete = update._meta?.['codebuddy.ai/toolArgumentsComplete'] === true || update.status === 'pending'
        const known = this.calls.get(update.toolCallId)
        if (known === undefined) {
          if (!complete) {
            // 参数流式生成中:先登记名字,等完整形态再发射。
            this.calls.set(update.toolCallId, {
              id: update.toolCallId,
              rawName: toolNameOf(update),
              dshName: toolNameOf(update),
              argsJson: JSON.stringify(update.rawInput ?? {}),
              announced: false,
              waiting: [],
            })
            return
          }
          this.announceCall(update.toolCallId, toolNameOf(update), update.rawInput ?? {})
          return
        }
        if (!known.announced && complete) {
          const rawInput = Object.keys(update.rawInput ?? {}).length > 0 ? update.rawInput! : {}
          this.announceCall(update.toolCallId, toolNameOf(update), rawInput)
        }
        return
      }
      case 'tool_call_update': {
        if (update.toolCallId === undefined) return
        if (update.status !== 'completed' && update.status !== 'failed') return
        if (update._meta?.['codebuddy.ai/isSubagent'] === true) this.subagentCallIds.add(update.toolCallId)
        let known = this.calls.get(update.toolCallId)
        if (known === undefined) {
          // 兜底:缺 pending 直达 completed 的路径,用 update 自带 rawInput 补发。
          const rawInput = Object.keys(update.rawInput ?? {}).length > 0 ? update.rawInput! : {}
          this.announceCall(update.toolCallId, toolNameOf(update), rawInput)
          known = this.calls.get(update.toolCallId)!
        }
        if (!known.announced) this.announceCall(update.toolCallId, known.rawName, {})
        this.firstResultSeen = true
        const outcome: ToolOutcome = { text: update.rawOutput?.text ?? '', isError: update.status === 'failed' }
        known.outcome = outcome
        for (const waiter of known.waiting.splice(0)) waiter.resolve(outcome)
        this.confirmTodo(update.toolCallId, known.rawName, outcome.text)
        this.finishMirror(update.toolCallId, outcome.text)
        this.wakeAll()
        return
      }
      default:
        return
    }
  }

  /** 参数完整的工具调用:注册回放工具 → 段内发射 tool-call 块。 */
  private announceCall(callId: string, rawName: string, rawInput: Record<string, unknown>): void {
    const argsJson = JSON.stringify(rawInput)
    const alias = imageReadAlias(rawName, argsJson)
    const dshName = alias?.name ?? rawName
    const existing = this.calls.get(callId)
    if (existing?.announced === true) return
    // 空/坏参数的 DelegateTool 调用(模型偶发):CLI 本地会把它改写成合法 JSON
    // 后继续(实测 callModelInputFilter "Rewrote 1 unrepairable JSON
    // function_call(s)"),但**不一定再回 completed 更新**——本侧若一直等它,
    // 回放工具会挂到回合被回收为止(实测 12 分钟,期间 dsh 侧整个 step 不动)。
    // 这类调用 CLI 是本地兜底执行的,直接给回放工具一个终局结果。
    const malformedDelegate = rawName === 'delegate_tool'
      && (typeof rawInput['toolId'] !== 'string' || (rawInput['toolId'] as string).length === 0)
    this.calls.set(callId, {
      id: callId,
      rawName,
      dshName,
      argsJson,
      announced: true,
      ...(alias === undefined ? {} : { imagePath: alias.path }),
      waiting: existing?.waiting ?? [],
      ...(existing?.outcome === undefined ? {} : { outcome: existing.outcome }),
      ...(malformedDelegate && existing?.outcome === undefined
        ? {
            outcome: {
              text: 'DelegateTool 调用缺少 toolId(空参数/坏 JSON):CodeBuddy CLI 已把该调用改写成合法 JSON 继续,本侧不执行。'
                + '正确形态:{"toolId":"dsh_<工具名>","input":{…}}。',
              isError: true,
            } satisfies ToolOutcome,
          }
        : {}),
    })
    if (/"run_in_background"\s*:\s*true|"background"\s*:\s*true/.test(argsJson)) this.backgroundLaunched = true
    // 镜像代理必须用保留前缀注册:同名注册会**遮蔽 dsh 真工具**,桥的
    // `dsh_<name>` 调用就会打到镜像上(实测 dsh_read 全程报"未知的工具调用",
    // 模型据此判定工具坏掉)。`cli_read` 只承接 CLI 原生调用,与桥彻底分名。
    const mirrorName = `${CLI_MIRROR_TOOL_PREFIX}${dshName}`
    this.ensureReplayTool(mirrorName)
    const segment = this.openSegment()
    this.closeOpenBlock(segment)
    const index = segment.blockIndex++
    segment.calls.push(callId)
    segment.chunks.push({
      type: 'block-end',
      index,
      block: { type: 'tool-call', id: ToolCallId(callId), name: mirrorName, arguments: argsJson },
    })
    this.landTodo(callId, rawName, rawInput)
    this.maybeStartMirror(callId, rawInput)
    this.wakeAll()
  }

  /** 取(或建)当前打开的段。 */
  private openSegment(): Segment {
    const last = this.segments[this.segments.length - 1]
    if (last !== undefined && !last.closed) return last
    const segment: Segment = { chunks: [], cursor: 0, calls: [], closed: false, outcome: 'settle', blockIndex: 0 }
    this.segments.push(segment)
    return segment
  }

  private closeOpenBlock(segment: Segment): void {
    const open = segment.open
    if (open === undefined) return
    segment.open = undefined
    if (open.text.length === 0) return
    if (open.kind === 'text') this.hasText = true
    segment.chunks.push({
      type: 'block-end',
      index: open.index,
      block: open.kind === 'text' ? { type: 'text', text: open.text } : { type: 'reasoning', text: open.text },
    })
  }

  private closeSegment(segment: Segment, outcome: Segment['outcome']): void {
    if (segment.closed) return
    this.closeOpenBlock(segment)
    segment.closed = true
    segment.outcome = outcome
    this.boundarySeenAt = 0
    this.usageGraceUntil = 0
    this.toolExecutingSeen = false
    this.firstResultSeen = false
    this.wakeAll()
  }

  /** 心跳:steer 轮询 → 看门狗 → 收段判定 → tail 收尾。 */
  private tick(): void {
    if (this.disposed || this.finished) return
    this.pollInsertions()
    this.checkStall()
    if (this.disposed || this.finished) return
    this.checkSegmentBoundary()
    this.checkTail()
  }

  /** 收段判定:工具边界。 */
  private checkSegmentBoundary(): void {
    const segment = this.segments[this.segments.length - 1]
    if (segment === undefined || segment.closed || segment.calls.length === 0) return
    const now = Date.now()
    // 模型调用结束的三种信号:phase=tool_executing / 首个工具结果 / 静默兜底。
    if (this.boundarySeenAt === 0) {
      const boundary = this.toolExecutingSeen
        || this.firstResultSeen
        || now - this.lastProgressAt > this.boundaryQuietMs
      if (!boundary) return
      this.boundarySeenAt = now
      // 用量样本可能晚到 ~100ms;给它一个短宽限期,让本段带上自己的用量。
      this.usageGraceUntil = segment.usage === undefined ? now + this.usageGraceMs : 0
      this.armCheck(this.usageGraceUntil - now + 5)
      return
    }
    if (segment.usage === undefined && this.usageGraceUntil > 0 && now < this.usageGraceUntil) return
    this.closeSegment(segment, 'tools')
  }

  /** tail 窗口:prompt 干净收尾后继续抽流(后台任务会自发续跑)。 */
  private checkTail(): void {
    // 失败分类:prompt 结果里的 refusal/_meta 错误(配额/认证等不重试),
    // 或 JSON-RPC/传输层错误(带 code/data 分类)。两者都翻成一行可读原因。
    if (this.promptFailure !== undefined) {
      this.failRun(
        new Error(`CodeBuddy 中断:${formatFailureLine(this.promptFailure, this.conn?.stderrNote())}`),
        this.promptFailure.retryable,
      )
      return
    }
    if (this.promptError !== undefined) {
      const failure = failureOfError(this.promptError)
      this.failRun(
        new Error(`CodeBuddy ACP 请求失败:${formatFailureLine(failure, this.conn?.stderrNote())}`),
        failure.retryable,
      )
      return
    }
    if (!this.promptSettled || this.inFlight > 0 || this.aborted) return
    // 静默失败:end_turn 但零文本零工具(配额/服务端异常)——首段重启,否则报错。
    if (this.progressSamples === 0 || (!this.hasText && this.calls.size === 0)) {
      this.failRun(new Error(`CodeBuddy 静默失败(stopReason: ${this.stopReason ?? 'none'};`
        + `${this.progressSamples} 次进展、0 次文本/工具产出)——可能是配额受限或服务端异常`))
      return
    }
    const segment = this.segments[this.segments.length - 1]
    if (segment === undefined || segment.closed) { this.finishTurn(); return }
    const tailQuietMs = this.to.tailQuietMs ?? 5_000
    const tailBgQuietMs = this.to.tailBgQuietMs ?? 600_000
    const tailCapMs = this.to.tailCapMs ?? 1_800_000
    // 老 CLI 无 agentPhase 心跳:无从判断空闲,立即收尾(与旧行为一致)。
    if (!this.agentPhaseSeen || tailQuietMs <= 0 || tailCapMs <= 0 || this.sessionEnded) {
      this.closeSegment(segment, 'settle')
      this.finishTurn()
      return
    }
    const now = Date.now()
    this.tailStartAt ??= now
    this.tailDeadline ??= this.tailStartAt + tailCapMs
    // 起了后台任务且尚未见续跑内容:放宽到 tailBgQuietMs(任务期间 CLI 可以
    // 长时间零 update);续跑内容一出现即回到短阈值。
    const continuationSeen = this.lastContentAt >= this.tailStartAt + tailQuietMs
    // CLI 已报空闲(agentPhase=idle):不再等后台宽限,用最短预算收尾。
    const cliIdle = this.lastIdlePhaseAt !== undefined && this.lastIdlePhaseAt >= this.tailStartAt
    const budgetMs = cliIdle ? tailQuietMs
      : this.backgroundLaunched && !continuationSeen ? tailBgQuietMs : tailQuietMs
    // 静默判定只看"真实活动"(内容 / 工具执行中相位):session_info 心跳不算
    // 活动,否则空闲的 CLI 靠心跳无限续命,只能等满 tailCapMs(实测:会话跑完
    // 仍显示"进行中"最长 30 分钟)。
    const lastActivityAt = Math.max(this.lastContentAt, this.lastToolExecutingAt)
    if (now - lastActivityAt >= budgetMs || now >= this.tailDeadline) {
      this.closeSegment(segment, 'settle')
      this.finishTurn()
      return
    }
    this.armCheck(Math.min(lastActivityAt + budgetMs, this.tailDeadline) - now + 5)
  }

  /** 看门狗:静默判死已整体移除——只保留"在途工具永不返回"的硬顶兜底。 */
  private checkStall(): void {
    if (this.stallTimedOut || this.disposed) return
    const idleFor = Date.now() - this.lastProgressAt
    const pendingTools = [...this.calls.values()].some(call => call.announced && call.outcome === undefined)
    if (pendingTools) {
      // 在途工具(长工具分钟级无心跳)的硬顶兜底:正常工具靠结果收尾,
      // 只有"工具永不返回 + 消费方被回收"才会走到这里(防进程泄漏/回合悬空)。
      const cap = this.to.guardCapMs ?? 1_800_000
      if (cap > 0 && idleFor > cap) this.stall(cap)
      return
    }
    // 纯等待(等上游响应/长思考)不再判死:CLI 可以长时间零事件,只要进程
    // 还活着就继续等;终止交给用户手动停止或回合取消。tail 窗口内的收尾
    // 由 armCheck 的阈值负责,不在此列。
  }

  private stall(capMs: number = this.lastBudgetMs): void {
    this.stallTimedOut = true
    if (this.acpSessionId !== '') this.conn?.notify('session/cancel', { sessionId: this.acpSessionId })
    if (this.killTimer === undefined) {
      const timer = setTimeout(() => { try { this.conn?.kill() } catch { /* 已退出 */ } }, 5_000)
      timer.unref?.()
      this.killTimer = timer
    }
    this.failRun(new Error('CodeBuddy ACP 调用超时(在途工具超过'
      + ` ${Math.round(capMs / 1000)}s 无响应,本回合历史最大进展间隔 ${Math.round(this.maxGapMs / 1000)}s)`
      + `${this.conn?.stderrNote() ?? ''}`))
  }

  private armProgress(): void {
    const now = Date.now()
    this.maxGapMs = Math.max(this.maxGapMs, now - this.lastProgressAt)
    this.stepState.maxGapMs = this.maxGapMs
    this.lastProgressAt = now
    this.progressSamples += 1
    this.lastBudgetMs = this.progressSamples <= this.to.idleWarmupLines
      ? this.to.idleMaxMs
      : Math.min(Math.max(this.maxGapMs * this.to.idleFactor, this.to.idleMinMs), this.to.idleMaxMs)
  }

  // ── steer 轮询 / todo / 镜像 ───────────────────────────────────────────

  /**
   * 未 claim 的 next-step 插话 → ACP `session/steer`(下一个内部边界注入)。
   *
   * C1 下 loop 会在**下一个模型调用边界**claim 这条消息并原生写 `user/message`
   * ——插话的队列停留不再是一整轮(旧实现的巨型 step 才需要手工摘队列)。
   */
  private pollInsertions(): void {
    const now = Date.now()
    if (now - this.lastSteerPoll < this.steerPollMs) return
    this.lastSteerPoll = now
    if (this.aborted || this.acpSessionId === '' || this.conn === undefined) return
    try {
      for (const insertion of foldPendingInsertions(this.deps.session?.ownEvents?.() ?? [])) {
        if (!insertion.steer) continue
        if (!this.deps.markForwarded(insertion.id)) continue
        const conn = this.conn
        if (conn === undefined) return
        const queuePrompt = (): void => { this.sendPrompt(insertion.text, []) }
        void conn.request<{ steered?: boolean }>(
          'session/steer',
          { sessionId: this.acpSessionId, contentBlocks: [{ type: 'text', text: insertion.text }] },
          20_000,
        ).then(
          result => { if (result?.steered !== true) queuePrompt() },
          () => queuePrompt(),
        )
      }
    } catch { /* 插话轮询失败不影响主流程 */ }
  }

  private replayTodos(): void {
    try {
      const state = this.deps.todoStateOf()
      if (state !== undefined && state.snapshot().length > 0) this.emitTodo(state)
    } catch { /* 展示性桥接不阻断对话 */ }
  }

  private emitTodo(state: TodoListState): void {
    try {
      this.deps.session?.append?.('todo/write', { todos: state.snapshot() })
    } catch { /* 展示性桥接不阻断对话 */ }
  }

  private landTodo(callId: string, name: string, rawInput: Record<string, unknown>): void {
    const state = this.deps.todoStateOf()
    if (state === undefined) return
    const kind = todoToolKind(name)
    if (kind === undefined) return
    try {
      if (kind === 'taskupdate') { state.deferTaskUpdate(callId, rawInput); return }
      if (state.applyToolCall(name, rawInput)) this.emitTodo(state)
    } catch { /* 展示性桥接不阻断对话 */ }
  }

  private confirmTodo(callId: string, name: string, text: string): void {
    const state = this.deps.todoStateOf()
    if (state === undefined || todoToolKind(name) === undefined) return
    try {
      state.applyToolResult(name, text)
      if (state.resolveTaskUpdate(callId, text)) this.emitTodo(state)
    } catch { /* 展示性桥接不阻断对话 */ }
  }

  private maybeStartMirror(callId: string, rawInput: Record<string, unknown>): void {
    if (!this.subagentCallIds.has(callId) || this.mirrors.has(callId)) return
    if (this.stepState.mirroredCalls.has(callId)) return
    if (this.acpSessionId === '') return
    const sessions = (this.deps.ctx as unknown as { get?: (key: string) => unknown }).get?.('sessions') as
      | { create?: (id?: unknown, options?: { meta?: Record<string, unknown> }) => { readonly id: string; append: (type: string, data: unknown, opts?: unknown) => { readonly seq: number } | undefined } }
      | undefined
    if (sessions?.create === undefined) return
    const description = rawInput['description']
    const prompt = rawInput['prompt']
    const attachments = this.deps.attachmentsOf()
    const mirror = new SubagentMirror({
      sessions: sessions as never,
      parentSessionId: this.deps.dshSessionId,
      cwd: this.deps.cwd,
      acpSessionId: this.acpSessionId,
      ...(this.deps.nativeBaseDir !== undefined ? { projectsRoot: this.deps.nativeBaseDir } : {}),
      ...(this.deps.childSession?.header?.agentPreset === undefined
        ? {}
        : { agentPreset: this.deps.childSession.header.agentPreset }),
      ...(attachments === undefined
        ? {}
        : { attachments: { saveImage: (data, mediaType) => attachments.saveImage({ data, mediaType }) } }),
    })
    mirror.start({
      label: typeof description === 'string' && description.length > 0 ? description : 'CodeBuddy 子代理',
      prompt: typeof prompt === 'string' ? prompt : '',
      delegationDepth: (this.deps.childSession?.header?.delegationDepth ?? 0) + 1,
    })
    this.mirrors.set(callId, mirror)
    this.stepState.mirroredCalls.add(callId)
  }

  private finishMirror(callId: string, outputText: string): void {
    const mirror = this.mirrors.get(callId)
    if (mirror === undefined) return
    void mirror.finish(agentIdFromOutput(outputText))
    this.mirrors.delete(callId)
  }

  // ── 唤醒机制 ───────────────────────────────────────────────────────────

  private waitEvent(): Promise<void> {
    return new Promise<void>(resolve => { this.wake = resolve })
  }

  private wakeAll(): void {
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }
}
