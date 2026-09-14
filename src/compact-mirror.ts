/**
 * 镜像 CodeBuddy CLI 自己的压缩到 dsh(纯逻辑同步,**零 token**)。
 *
 * ## 为什么需要
 * dsh 只是渲染层:codebuddy 会话的真实上下文与压缩都由 CLI 负责,所以插件接管了
 * dsh 的自动压缩(`registerCompactDelegation`)。但 CLI 自己压完之后,dsh 界面上
 * 什么都不显示,用户看不出"这里压缩过"。本模块把 CLI 的那次压缩**镜像**成 dsh 的
 * 一次压缩事务,于是 UI 出现标准的压缩卡。
 *
 * ## 关键:不调模型
 * dsh 的压缩卡由「一条 `surfaceOp: replace` 的 checkpoint 消息」带出来
 * (`ui-chat/.../command.ts` 的 `compactSource()` 要求 `isReplacementSurfaceEvent`)。
 * 本模块**自己写这组事件**,摘要文本直接照抄 CLI 的原文——不调用任何 LLM,
 * 因此不消耗 token,只有本地文件读取 + 本地日志写入。
 *
 * ## 事件形状必须与 dsh 原生压缩逐字对齐
 * 会话层会校验,少任何一项 append 都会抛错(而错误会被本模块的 catch 吞掉 →
 * 功能静默失效),所以:
 * - checkpoint 用 `createUserMessage` 造(自动带 `role:'user'` 与稳定 `id`);
 * - replace 事件的 `sourceEventSeqs` 必须**覆盖每一个被遮蔽节点**,写法与
 *   `compaction-basic/src/region.ts` 一致:`[startSeq, summarySeq, ...shadowedSeqs]`。
 *
 * ## 检测
 * CLI 的会话文件 `~/.codebuddy/projects/<slug(cwd)>/<acpId>.jsonl` 里,它自己的每次
 * 压缩都会落一条 `{"type":"summary", "summary": "...", "providerData":{"source":"periodic"}}`
 * (实测;`source` 还有 `initial-user-message`,那是种子首条,不算压缩)。本模块按
 * 字节偏移量 tail 该文件,只认新增的 `periodic` 记录。
 *
 * ## 触发时机与安全
 * 跑在 `agent/pre-step`(回合进行中、step 之间)——与 dsh 自己的压缩同一个相位,
 * 所以事务的 `turn` 归属天然正确,也不会跨 `turn/end`。整组事件同步追加完,
 * 中途不 yield。
 * @module subagent-codebuddy/compact-mirror
 */

import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ConversationStore } from './conversations.js'
import { conversationFilePath } from './native-session.js'

/** 挂载依赖。 */
export interface CompactMirrorDeps {
  ctx: Context
  conversations: ConversationStore
  /** 本插件注册的 provider 名:只有路由到它的会话才镜像。 */
  providerName: string
  /** CLI 会话文件基目录(测试可注入;默认 `~/.codebuddy/projects`)。 */
  nativeBaseDir?: string
}

/**
 * 保留尾部的比例(与 dsh 自己的 `retainRatio` 默认值一致):镜像时遮蔽头部、
 * 留住最近的这段。这样 dsh 的压力表与"重建素材"和 CLI 的真实状态大致对齐。
 *
 * 注意按 **surface 自身**的 token 数算,不按 `measurement.totalTokens`——后者含
 * CLI 上报的 usage 基线(可能远大于 surface),照它算会得出"没有可压区间"而
 * 静默不镜像。
 */
const MIRROR_RETAIN_RATIO = 0.16

/** dsh 的 checkpoint 消息框架(与 compaction-basic 的 `frameSummary` 逐字一致)。 */
const CHECKPOINT_PREAMBLE =
  'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.'
const SUMMARY_OPEN_TAG = '<compacted-summary>'
const SUMMARY_CLOSE_TAG = '</compacted-summary>'

/** 日志前缀。 */
const LOG_TAG = '[subagent-codebuddy/mirror]'

/** 最小日志面。 */
interface LoggerFace {
  info: (message: string) => void
  warn: (message: string) => void
}

const NOOP_LOGGER: LoggerFace = { info: () => {}, warn: () => {} }

function loggerOf(ctx: Context): LoggerFace {
  try {
    const logger = (ctx as unknown as { logger?: Partial<LoggerFace> }).logger
    if (logger === undefined) return NOOP_LOGGER
    return {
      info: typeof logger.info === 'function' ? logger.info.bind(logger) : NOOP_LOGGER.info,
      warn: typeof logger.warn === 'function' ? logger.warn.bind(logger) : NOOP_LOGGER.warn,
    }
  } catch {
    return NOOP_LOGGER
  }
}

/** 镜像要读的 agent 面。 */
interface MirrorAgent {
  readonly session: MirrorSession
}

/** 镜像要读/写的 session 面。 */
interface MirrorSession {
  readonly id: string
  readonly header?: { readonly cwd?: string }
  /** 当前 surface 上的节点 seq(按 surface 顺序)。 */
  readonly surface: { readonly nodes: readonly number[] }
  readonly requestHeader?: () => { config?: { provider?: string; model?: string } } | undefined
  snapshotEvents?: () => readonly MirrorEvent[]
  eventAt?: (seq: number) => MirrorEvent | undefined
  append: (
    type: string,
    data: unknown,
    opts?: { surfaceOp?: unknown; sourceEventSeqs?: readonly number[] },
  ) => { readonly seq: number }
}

/** 镜像要读的事件面。 */
interface MirrorEvent {
  readonly type: string
  readonly seq: number
  readonly data?: {
    readonly compactionId?: unknown
    readonly message?: { readonly content?: readonly MirrorBlock[] }
  }
}

/** 工具配对计数要用到的内容块。 */
interface MirrorBlock {
  readonly type?: unknown
}

/** tokenMeter 的测量面。 */
interface MeterFace {
  measure: (session: unknown) => {
    readonly totalTokens: number
    /** 当前 surface 自身的计价 token(不含 usage 基线)。 */
    readonly surfaceTokens: number
    readonly nodes: readonly { readonly seq: number; readonly tokens: number; readonly heuristicTokens: number }[]
  }
}

/** 每个 CLI 会话的读取游标(字节)。 */
interface Cursor {
  /** 游标归属的 CLI 会话 id:映射换会话时游标必须重来。 */
  acpId: string
  offset: number
}

const cursors = new Map<string, Cursor>()

/**
 * 在每个 agent 的 `agent/pre-step` 上检查一次:CLI 是否新压了一次?压了就镜像。
 * 镜像失败只记日志,绝不影响回合。
 * @param deps - 挂载依赖。
 */
export function registerCompactMirror(deps: CompactMirrorDeps): void {
  const log = loggerOf(deps.ctx)
  // 不标注参数/返回值,直接吃 dsh 声明的事件签名(返回 next() 的 PreStepDecision)。
  deps.ctx.on('agent/pre-step', async (payload, next) => {
    try {
      await mirrorOnce(deps, payload as unknown as { agent?: MirrorAgent; turn?: number }, log)
    } catch (error) {
      log.warn(`${LOG_TAG} 镜像 CLI 压缩失败(不影响回合): `
        + (error instanceof Error ? error.message : String(error)))
    }
    return await next()
  })
}

/** 一次检查:读新增的 CLI 压缩记录,有就镜像。 */
async function mirrorOnce(
  deps: CompactMirrorDeps,
  payload: { agent?: MirrorAgent; turn?: number },
  log: LoggerFace,
): Promise<void> {
  const agent = payload.agent
  const session = agent?.session
  if (session === undefined) return
  // 只有路由到本 provider 的会话才镜像(和压缩接管同一判据)。
  if (session.requestHeader?.()?.config?.provider !== deps.providerName) return
  const record = deps.conversations.get(session.id)
  if (record === undefined) return

  const cwd = session.header?.cwd ?? process.cwd()
  const file = conversationFilePath(record.acpId, cwd, deps.nativeBaseDir)
  const summaryText = latestNewPeriodicSummary(file, cursorFor(session.id, record.acpId, file))
  if (summaryText === undefined) return

  const appended = appendMirroredCompaction(deps, session, payload.turn ?? null, summaryText)
  if (appended) {
    log.info(`${LOG_TAG} 已把 CodeBuddy CLI 的压缩镜像到 dsh 会话 ${session.id}`
      + '(纯逻辑同步,未调用模型、未消耗 token)')
  }
}

/**
 * 取(或初始化)该会话的读取游标;首次见到时直接跳到文件末尾,不回放历史压缩。
 * 映射换到另一个 CLI 会话(acpId 变了)时游标重来。
 */
function cursorFor(sessionId: string, acpId: string, file: string): Cursor {
  const existing = cursors.get(sessionId)
  if (existing !== undefined && existing.acpId === acpId) return existing
  let offset = 0
  try {
    offset = statSync(file).size
  } catch {
    offset = 0
  }
  const cursor: Cursor = { acpId, offset }
  cursors.set(sessionId, cursor)
  return cursor
}

/**
 * 从上次位置读到文件末尾,返回**最新**一条 CLI 自己压的摘要文本。
 *
 * 只认 `type === 'summary'` 且 `providerData.source === 'periodic'` 的记录:
 * CLI 的会话文件里 `summary` 记录还有 `initial-user-message`(那是种子首条,
 * 不是压缩)。尾部残行留到下次再解析。
 * @param file - CLI 会话文件。
 * @param cursor - 按字节的读取游标(原地推进)。
 * @returns 新增压缩里最新一条的摘要文本;没有则 undefined。
 */
function latestNewPeriodicSummary(file: string, cursor: Cursor): string | undefined {
  let size: number
  try {
    size = statSync(file).size
  } catch {
    return undefined
  }
  // 文件被截断/重建(换会话、清理):游标跟着回退,避免永久错位。
  if (size < cursor.offset) cursor.offset = 0
  if (size === cursor.offset) return undefined

  const length = size - cursor.offset
  const buffer = Buffer.allocUnsafe(length)
  const fd = openSync(file, 'r')
  let read = 0
  try {
    read = readSync(fd, buffer, 0, length, cursor.offset)
  } finally {
    closeSync(fd)
  }
  const text = buffer.subarray(0, read).toString('utf8')
  const lastBreak = text.lastIndexOf('\n')
  if (lastBreak < 0) return undefined
  const consumed = text.slice(0, lastBreak + 1)
  cursor.offset += Buffer.byteLength(consumed, 'utf8')

  let latest: string | undefined
  for (const line of consumed.split('\n')) {
    if (line.trim().length === 0) continue
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    const candidate = record as {
      type?: unknown
      summary?: unknown
      providerData?: { source?: unknown }
    }
    if (candidate.type !== 'summary') continue
    if (candidate.providerData?.source !== 'periodic') continue
    if (typeof candidate.summary !== 'string' || candidate.summary.trim().length === 0) continue
    latest = candidate.summary
  }
  return latest
}

/**
 * 追加一组与 dsh 原生压缩同形的会话事件,让 UI 渲染出压缩卡。
 *
 * 事件顺序是契约(`compaction/summary` 紧跟其 replace 的 checkpoint),四条
 * 同步写完:start → summary → checkpoint(replace) → end。
 * @param deps - 挂载依赖。
 * @param session - 目标 dsh 会话。
 * @param turn - 当前打开的回合(自动路径;standalone 传 null)。
 * @param summaryText - CLI 自己的摘要原文。
 * @returns 是否真的追加了事务。
 */
function appendMirroredCompaction(
  deps: CompactMirrorDeps,
  session: MirrorSession,
  turn: number | null,
  summaryText: string,
): boolean {
  if (hasOpenCompaction(session)) return false
  const meter = deps.ctx.get('tokenMeter') as MeterFace | undefined
  if (meter?.measure === undefined) return false
  const range = selectMirrorRange(session, meter)
  if (range === null) return false

  const compactionId = randomUUID()
  const header = session.requestHeader?.()?.config
  const lifecycle = { compactionId, turn }
  const startEvent = session.append('compaction/start', lifecycle)
  const summaryEvent = session.append('compaction/summary', {
    compactionId,
    summary: [{ type: 'text', text: summaryText }],
    shadowedRange: { start: range.start, end: range.end },
    shadowedSeqs: range.shadowedSeqs,
    shadowedTokenCount: range.shadowedTokenCount,
    provider: header?.provider ?? deps.providerName,
    model: header?.model ?? 'unknown',
  })
  // checkpoint 必须与 dsh 原生压缩逐字同形:
  // - createUserMessage 带 role:'user' 与稳定 id(会话层校验 user/message 形状);
  // - source 带 compact 标记(UI 靠它识别成压缩卡而不是普通用户消息);
  // - sourceEventSeqs 必须覆盖每一个被遮蔽节点(会话层强校验),写法与
  //   region.ts 一致:[startSeq, summarySeq, ...shadowedSeqs]。
  const checkpoint = createUserMessage({
    content: [
      { type: 'text', text: `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}` },
      { type: 'text', text: summaryText },
      { type: 'text', text: SUMMARY_CLOSE_TAG },
    ],
    source: { kind: 'plugin', plugin: 'compact', compactionId },
  } as never)
  session.append('user/message', checkpoint, {
    surfaceOp: { op: 'replace', start: range.start, end: range.end },
    sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...range.shadowedSeqs],
  })
  session.append('compaction/end', lifecycle)
  return true
}

/**
 * 是否已有未闭合的压缩事务(有就别再开一个,dsh 的日志不变量禁止嵌套)。
 * 从日志尾部倒着扫,遇到第一个压缩事件即可判定——不必每次走完整本日志。
 */
function hasOpenCompaction(session: MirrorSession): boolean {
  const events = session.snapshotEvents?.() ?? []
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const type = events[index]!.type
    if (type === 'compaction/start') return true
    if (type === 'compaction/end') return false
  }
  return false
}

/**
 * 选一段可安全遮蔽的表面区间:遮蔽头部、留住尾部(比例见
 * {@link MIRROR_RETAIN_RATIO}),并把切点推到工具配对平衡处。
 * @param session - 目标会话。
 * @param meter - token 计量服务。
 * @returns 区间与阴影计价;无可压区间时为 null。
 */
function selectMirrorRange(
  session: MirrorSession,
  meter: MeterFace,
): { start: number; end: number; shadowedSeqs: number[]; shadowedTokenCount: number } | null {
  const measurement = meter.measure(session)
  const nodes = measurement.nodes
  if (nodes.length < 2) return null

  // 按 surface 自身计价算保留量(不能用 totalTokens:它含 CLI 的 usage 基线,
  // 照它算可能得出"整个 surface 都该保留"→ 永远不镜像)。
  const retainTokens = Math.floor(measurement.surfaceTokens * MIRROR_RETAIN_RATIO)
  let accumulated = 0
  let keepFromIdx = nodes.length
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    accumulated += nodes[index]!.tokens
    keepFromIdx = index
    if (accumulated >= retainTokens) break
  }
  // 切点必须落在工具配对平衡处(否则会切断 tool-call / tool-result)。
  while (keepFromIdx > 0 && !cutBalancedBefore(session, nodes[keepFromIdx]!.seq)) keepFromIdx -= 1
  if (keepFromIdx <= 0) return null

  const selected = nodes.slice(0, keepFromIdx)
  const shadowedSeqs = selected.map(node => node.seq)
  return {
    start: shadowedSeqs[0]!,
    end: shadowedSeqs[shadowedSeqs.length - 1]!,
    shadowedSeqs,
    shadowedTokenCount: selected.reduce((total, node) => total + node.heuristicTokens, 0),
  }
}

/**
 * 该 seq 之前的那一刀是否工具配对平衡(未答复的 tool-call 数为 0)。
 * 与 dsh 的 `toolPairingBalancedBefore` 同一判据,这里自己走一遍以避免把
 * compaction 包拉成插件依赖。**按当前 surface 顺序走**(不是按日志顺序)——
 * 被替换过的节点已经不在 surface 上,不能计入。
 * @param session - 目标会话。
 * @param seq - 要检查的切点右侧节点。
 * @returns 平衡时为 true。
 */
function cutBalancedBefore(session: MirrorSession, seq: number): boolean {
  if (session.eventAt === undefined) return false
  let inProgress = 0
  for (const nodeSeq of session.surface.nodes) {
    // 切点在节点**之前** → 先判平衡,再吃掉这个节点的增量(与 dsh 的
    // cutBalanced[index] 语义一致)。
    if (nodeSeq === seq) return inProgress === 0
    const event = session.eventAt(nodeSeq)
    if (event === undefined) return false
    if (event.type === 'assistant/message') {
      const content = event.data?.message?.content ?? []
      inProgress += content.filter(block => block.type === 'tool-call').length
    } else if (event.type === 'tool/result') {
      inProgress -= 1
      if (inProgress < 0) return false
    }
  }
  return false
}
