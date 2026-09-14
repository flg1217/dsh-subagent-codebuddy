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
 * - 其它会话 → 回落到 dsh 自己的 `compaction.compactNow`,行为不变。
 *
 * 同一文件还负责**自动压缩接管**:dsh 的两条自动路径对 codebuddy 会话一律不压
 * (真实上下文归 CLI),判定按每轮路由的 provider 做——同一 preset 上的其它会话
 * 完全不受影响。寻址方式见 {@link registerCompactDelegation}(realm 隔离 + 名册的
 * `serviceFor`,不是猜 scope)。
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

import type { Context } from '@deepseek-ai/cordis'
import { AcpConnection, DEFAULT_ACP_RUN_TIMEOUTS, cliToolPolicyArgs, usageOfUpdate } from './acp.js'
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ConversationStore } from './conversations.js'
import { TurnPump } from './pump.js'

/** 命令结果(与 dsh commands 服务的形状一致)。 */
export type CompactCommandResult =
  | { kind: 'success'; text?: string }
  | { kind: 'error'; text: string }

/** `agent.ctx` 上的命令注册面(最小结构类型,不引 commands 包的依赖)。 */
interface ScopedCommandsFace {
  register?: (definition: {
    name: string
    description: string
    handler: (invocation: CompactInvocation) => Promise<CompactCommandResult> | CompactCommandResult
  }) => (() => void) | undefined
}

/** 命令调用我们消费的部分。 */
export interface CompactInvocation {
  readonly commandId: string
  readonly rawInput: string
  readonly signal: AbortSignal
  readonly agent: {
    readonly session: {
      readonly id: string
      readonly header: { readonly cwd?: string }
    }
  }
}

/** 挂载依赖(由插件 apply 提供)。 */
export interface CompactCommandDeps {
  ctx: Context
  /** CLI 可执行(与 provider 的 command 一致)。 */
  command: string
  prefixArgs: string[]
  extraArgs: string[]
  modelOf: () => string
  conversations: ConversationStore
  /** 本插件注册的 provider 名:自动压缩按"最新请求是否路由到它"判定归属。 */
  providerName: string
  /** 该会话的回合泵是否在跑(默认查 TurnPump;测试可注入)。 */
  isSessionBusy?: (sessionId: string) => boolean
}

/** 自动压缩接管要读的会话面(会话 id + 最新一次请求的路由 provider)。 */
interface CompactDelegableAgent {
  readonly session?: {
    readonly id?: unknown
    readonly requestHeader?: () => { config?: { provider?: string } } | undefined
  }
}

/** 转发 `/compact` 的等待上限(压缩可能很久,给足 15 分钟)。 */
const COMPACT_TIMEOUT_MS = 15 * 60_000

/**
 * 把一条 `/compact` 转发给该会话的 CLI(短连接 resume + 用户命令 prompt)。
 * @param deps - 挂载依赖(命令/参数/会话映射)。
 * @param sessionId - dsh 会话 id(经映射找到 CLI 会话)。
 * @param cwd - CLI 工作目录。
 * @param signal - 命令取消信号。
 * @returns 命令结果。
 */
export async function forwardCompactToCli(
  deps: CompactCommandDeps,
  sessionId: string,
  cwd: string,
  signal: AbortSignal,
): Promise<CompactCommandResult> {
  const record = deps.conversations.get(sessionId)
  if (record === undefined) {
    return { kind: 'error', text: '这个会话还没有 CodeBuddy CLI 会话(先发一条消息,再压缩)。' }
  }
  // 回合进行中不开第二条 CLI 连接:同一 ACP 会话被并发操作可能互相冲突
  // (主回合泵正持有该会话)。自动压缩路径拿到 error 会回落内置压缩。
  const busy = deps.isSessionBusy?.(sessionId) ?? (TurnPump.forSession(sessionId) !== undefined)
  if (busy) {
    return { kind: 'error', text: '会话的回合正在运行中:等它结束后再压缩(避免与 CLI 的连接冲突)。' }
  }
  const argv = [
    deps.command,
    ...deps.prefixArgs,
    '--acp',
    '--model',
    deps.modelOf(),
    '--dangerously-skip-permissions',
    ...cliToolPolicyArgs(),
    ...deps.extraArgs,
  ]
  // 压缩过程中的用量样本:CLI 的压缩 agent 会把整段历史读进去摘要,它的
  // prompt_tokens 就是"压缩前上下文大小"——回给用户一个可核对的数字。
  let contextBefore: number | undefined
  const onUpdate = (update: Parameters<typeof usageOfUpdate>[0]): void => {
    const sample = usageOfUpdate(update)
    if (sample === undefined) return
    const tokens = sample.inputTokens + (sample.cacheReadTokens ?? 0)
    if (tokens > 0 && (contextBefore === undefined || tokens > contextBefore)) contextBefore = tokens
  }
  const conn = new AcpConnection(argv, cwd, onUpdate)
  const to = DEFAULT_ACP_RUN_TIMEOUTS
  try {
    await conn.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    }, to.firstMs)
    await conn.request('session/load', { sessionId: record.acpId, cwd, mcpServers: [] }, to.firstMs)
    if (signal.aborted) return { kind: 'error', text: '压缩已取消。' }
    // `/compact` 是 CLI 的用户命令(user-command,非模型消息):CLI 压它自己的历史。
    await conn.request('session/prompt', {
      sessionId: record.acpId,
      prompt: [{ type: 'text', text: '/compact' }],
    }, COMPACT_TIMEOUT_MS)
    const before = contextBefore === undefined
      ? ''
      : `压缩前上下文 ≈ ${Math.round(contextBefore / 1000)}K tokens;`
    return {
      kind: 'success',
      text: `已让 CodeBuddy CLI 压缩其会话(${record.acpId.slice(0, 8)}…):${before}`
        + '下一轮请求的上下文占用会随之回落。',
    }
  } catch (error) {
    return {
      kind: 'error',
      text: `压缩转发失败: ${error instanceof Error ? error.message : String(error)}`,
    }
  } finally {
    conn.kill()
  }
}

/** compaction 服务面(最小结构类型,不引 compaction 包)。 */
interface CompactionFace {
  /** 手动压缩入口(空闲会话,`/compact` 用)。 */
  compactNow?: (agent: unknown, signal: AbortSignal, commandId: string) => Promise<{
    shadowedSeqs: readonly unknown[]
    shadowedTokenCount: number
  } | null>
  /** 自动压缩入口(压力阈值与 context-overflow 共用;接管点见 registerCompactDelegation)。 */
  compactIfNeeded?: (
    agent: CompactDelegableAgent,
    trigger: string,
    signal: AbortSignal,
  ) => Promise<unknown>
}

/** 非 codebuddy 会话:保持 dsh 自己的手动压缩行为(同样按 agent 寻址取服务)。 */
async function dshCompact(deps: CompactCommandDeps, invocation: CompactInvocation): Promise<CompactCommandResult> {
  const compaction = engineForAgent(deps, invocation.agent)
  if (compaction?.compactNow === undefined) {
    return { kind: 'error', text: '压缩服务不可用。' }
  }
  try {
    const result = await compaction.compactNow(invocation.agent, invocation.signal, invocation.commandId)
    if (result === null) return { kind: 'success', text: 'No compactable history yet.' }
    return {
      kind: 'success',
      text: `Compacted ${result.shadowedSeqs.length} history items (~${result.shadowedTokenCount} tokens).`,
    }
  } catch (error) {
    if (invocation.signal.aborted) return { kind: 'error', text: 'Compaction cancelled.' }
    return { kind: 'error', text: `Compaction failed: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * 自动压缩接管:codebuddy 会话**一律不做 dsh 压缩** —— dsh 只是渲染层,
 * 真实上下文与压缩都由 CLI 自己负责。
 *
 * **为什么必须拦在 `compactIfNeeded` 上(2026-09-14 实测):** dsh 侧没有
 * "把压缩委托出去"的事件缝(曾按 `compaction/delegate` 事件写过一版,源码核对
 * 后确认 compaction-basic 从不发这个事件 → 监听器永不触发,等于死代码)。
 * 现在改为在那个 compaction 实例上就地接管压缩入口(实例从哪来见下):
 * compaction-basic 的两条自动路径(`agent/pre-step` 的 pressure、
 * `agent/request-error` 的 context-overflow)都是 `this.compactIfNeeded(...)`,
 * 实例上的自有属性会遮蔽原型方法,所以接管后 dsh 不再压 codebuddy 会话。
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
 * **服务从哪来(2026-09-14 核实):** preset 把 compaction 放在 entry-local
 * realm 里(`isolate: { compaction: true }`),realm 外的一切都看不到它——宿主
 * ctx 看不到,**agent 自己的 ctx 也看不到**(`mount.ts:253` 的原文:"invisible to
 * everything outside the group — including the agent's own scope context and the
 * host")。所以不能靠 scope 猜;官方给"持有 agent 的外部调用者"留的路是
 * `agentPresets.serviceFor(agent, name)`:按 fiber 归属在服务表里找出该会话
 * preset 发布的那一个实例,并直接返回原始对象(不套 cordis 追踪代理)。
 *
 * **判定必须 per-agent:** 实例是按 preset 挂载共享的,但覆盖里的判断读的是
 * "该会话最新一次请求的路由 provider",所以只有走本插件的会话跳过 dsh 压缩,
 * 同一 preset 上的其它会话原样下调原方法(行为与不装接管时完全一致)。
 *
 * 手动 `/compact` 不受影响:它走 per-agent 命令覆盖(`handleCompactCommand`),
 * 在回合空闲时由用户触发,那里才转发 CLI 并等 maintenance 相位。`compactNow`
 * 的接管只是兜底(命令覆盖没挂上时全局命令会走到它),避免那条路压镜像。
 * @param deps - 挂载依赖(路由名与会话映射)。
 */
export function registerCompactDelegation(deps: CompactCommandDeps): void {
  // agent/created 让接管在首个 step 之前就位(compaction 的 pre-step 监听器
  // 注册得比我们早,晚一步就要多压一次)。recompose 等"先创建后 join preset"
  // 的路径此时还取不到实例,由下面的 step 边界复核补上。
  deps.ctx.on('agent/created', ({ agent }) => {
    ensureTakeover(deps, engineForAgent(deps, agent), 'agent/created')
  })
  // 自愈复核:每个 step 边界检查一次接管是否仍在(命中缓存即返回,零成本)。
  // 覆盖服务被替换、热重载、接管被清掉等"静默丢失"的路径——压缩风暴的代价
  // 远高于一次读表,而静默失效恰恰是最难发现的那种(实测踩过)。
  deps.ctx.on('agent/pre-step', async (payload, next) => {
    ensureTakeover(deps, engineForAgent(deps, agentOf(payload)), 'pre-step')
    return await next()
  })
}

/** preset 名册服务面(只用到"按 agent 寻址"这一个方法)。 */
interface PresetRosterFace {
  serviceFor?: (agent: unknown, name: string) => unknown
}

/** 事件载荷里的 agent(agent/created 与 agent/pre-step 都带)。 */
function agentOf(payload: unknown): unknown {
  return (payload as { agent?: unknown } | undefined)?.agent
}

/**
 * 找该 agent 的 preset 挂载的 compaction 实例(见 registerCompactDelegation
 * 里的寻址说明)。拿不到时返回 undefined:要么部署里根本没有 compaction
 * (那也就不存在压缩风暴),要么 dsh 太旧、没有名册服务。
 *
 * 名册缺席的部署(rosterless:没有 preset,模型面插件直接挂在宿主组合里)里
 * compaction 就在宿主平面,插件 ctx 自己看得到——那条路照旧走 `ctx.get`。
 */
function engineForAgent(deps: CompactCommandDeps, agent: unknown): CompactionFace | undefined {
  if (agent === undefined) return undefined
  const roster = serviceOf<PresetRosterFace>(deps.ctx, 'agentPresets')
  if (roster?.serviceFor === undefined) {
    const host = serviceOf<CompactionFace>(deps.ctx, 'compaction')
    if (host !== undefined) return host
    reportOnce(deps.ctx, 'no-roster', `${LOG_TAG} 拿不到 agentPresets.serviceFor 也拿不到宿主平面的 compaction:`
      + '压缩接管未安装,codebuddy 会话可能出现 dsh 侧压缩风暴(需要带 preset 名册的 dsh)')
    return undefined
  }
  try {
    const engine = roster.serviceFor(agent, 'compaction') as CompactionFace | undefined
    if (engine === undefined) {
      reportOnce(deps.ctx, 'no-compaction', `${LOG_TAG} 该 agent 的 preset 未挂载 compaction:无需接管`)
    }
    return engine
  } catch (error) {
    reportOnce(deps.ctx, 'service-for-threw', `${LOG_TAG} agentPresets.serviceFor 失败: ${String(error)}`)
    return undefined
  }
}

/** 取服务(不抛的安全入口;拿不到返回 undefined)。 */
function serviceOf<T>(ctx: Context | undefined, name: string): T | undefined {
  if (ctx === undefined) return undefined
  try {
    return (ctx as unknown as { get?: (name: string) => unknown }).get?.(name) as T | undefined
  } catch {
    return undefined
  }
}

/** 同一原因只报一次(step 边界每步复核,不节流会刷屏)。 */
const reportedReasons = new Set<string>()

function reportOnce(ctx: Context, key: string, message: string): void {
  if (reportedReasons.has(key)) return
  reportedReasons.add(key)
  takeoverLog(message)
  loggerOf(ctx).warn(message)
}

/** 已装覆盖的引擎(自愈复核用:读回校验,避免每步重复赋值)。 */
const patchedEngines = new WeakMap<object, { compactIfNeeded?: unknown; compactNow?: unknown }>()

/** 测试用:清掉"同一原因只报一次"与"每会话播报一次"的记忆。 */
export function resetTakeoverStateForTests(): void {
  reportedReasons.clear()
  announcedSessions.clear()
}

/**
 * 安装(或复核)接管。幂等:同一引擎实例只装一次,之后每次调用只是一次读表
 * 校验;发现覆盖丢失(服务替换/热重载/被清掉)会就地重装。
 * @returns 自动压缩接管当前是否生效。
 */
function ensureTakeover(deps: CompactCommandDeps, engine: CompactionFace | undefined, via: string): boolean {
  const log = loggerOf(deps.ctx)
  // 拿不到实例的原因由 engineForAgent 分类播报(无名册服务 / preset 未挂 compaction),
  // 这里只做"没有可接管对象"的静默返回。
  if (engine === undefined) return false
  const target = engine
  let installed = patchedEngines.get(target as object)
  if (installed === undefined) {
    installed = {}
    patchedEngines.set(target as object, installed)
  }

  // ── 自动路径:pressure + context-overflow ────────────────────────────────
  if (installed.compactIfNeeded !== undefined && target.compactIfNeeded === installed.compactIfNeeded) {
    return true
  }
  if (typeof target.compactIfNeeded !== 'function') {
    takeoverLog(`未找到 compaction.compactIfNeeded(via=${via}):自动压缩接管未安装`)
    log.warn(`${LOG_TAG} 未找到 compaction.compactIfNeeded(via=${via}):自动压缩接管未安装,`
      + 'codebuddy 会话可能出现 dsh 侧压缩风暴,请核对 dsh 版本')
    return false
  }
  const original = target.compactIfNeeded.bind(target)
  const patched: NonNullable<CompactionFace['compactIfNeeded']> = async (
    agent,
    trigger,
    signal,
  ) => {
    if (!isCodebuddyOwned(deps, agent)) return await original(agent, trigger, signal)
    announceTakeover(log, deps, agent, `自动压缩(${trigger})`)
    return null
  }
  if (!assignOverride(target, 'compactIfNeeded', patched, deps.ctx)) {
    takeoverLog(`自动压缩接管失败(via=${via}):compactIfNeeded 不可覆写`)
    log.warn(`${LOG_TAG} 自动压缩接管未生效(compactIfNeeded 不可覆写):`
      + 'codebuddy 会话可能出现 dsh 侧压缩风暴,请核对 dsh 版本')
    return false
  }
  installed.compactIfNeeded = patched
  takeoverLog(`已接管自动压缩(via=${via})`)

  // ── 手动路径兜底:per-agent 命令覆盖没挂上时,全局 /compact 会走这里 ──────
  if (installed.compactNow === undefined && typeof target.compactNow === 'function') {
    const originalNow = target.compactNow.bind(target)
    const patchedNow: NonNullable<CompactionFace['compactNow']> = async (agent, signal, commandId) => {
      const face = agent as CompactDelegableAgent
      if (!isCodebuddyOwned(deps, face)) return await originalNow(agent, signal, commandId)
      announceTakeover(log, deps, face, '手动压缩')
      return null
    }
    if (assignOverride(target, 'compactNow', patchedNow, deps.ctx)) installed.compactNow = patchedNow
  }
  return true
}

/**
 * 在真实服务实例上装一个覆盖方法,并在插件卸载时还原(删掉自有属性 → 原型方法
 * 重新生效)。安装不成功返回 `false`,调用方据此决定要不要告警。
 */
function assignOverride<K extends 'compactIfNeeded' | 'compactNow'>(
  target: CompactionFace,
  key: K,
  patched: NonNullable<CompactionFace[K]>,
  ctx: Context,
): boolean {
  try {
    target[key] = patched
  } catch {
    return false
  }
  if (target[key] !== patched) return false
  ctx.effect(() => () => {
    if (target[key] === patched) delete target[key]
  })
  return true
}

/**
 * 接管诊断落盘(`~/.dsh/codebuddy/compact-takeover.log`):控制台日志会随终端
 * 滚掉,"接管到底装没装"必须可事后核对(实测:静默失效时无从判断)。
 * 测试不写这个文件:测试的接管播报会混进生产诊断里,让这份日志不可信。
 */
function takeoverLog(line: string): void {
  if (process.env['NODE_ENV'] === 'test') return
  try {
    mkdirSync(join(homedir(), '.dsh', 'codebuddy'), { recursive: true })
    appendFileSync(join(homedir(), '.dsh', 'codebuddy', 'compact-takeover.log'),
      `${new Date().toISOString()} ${line}\n`)
  } catch { /* 诊断不影响主流程 */ }
}
/** 日志前缀(便于在 dsh 控制台/日志里定位本插件的压缩接管)。 */
const LOG_TAG = '[subagent-codebuddy/compact]'

/** 只依赖 info/warn 两个方法的最小日志面。 */
interface LoggerFace {
  info: (message: string) => void
  warn: (message: string) => void
}

const NOOP_LOGGER: LoggerFace = { info: () => {}, warn: () => {} }

/** 取 cordis 日志服务;拿不到就退化成静默(日志不该拖垮接管)。 */
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

/** 每个会话只播报一次:接管成功要看得见(否则"没报错"和"没生效"分不清)。 */
const announcedSessions = new Set<string>()

function announceTakeover(
  log: LoggerFace,
  deps: CompactCommandDeps,
  agent: CompactDelegableAgent,
  what: string,
): void {
  const sessionId = agent.session?.id
  if (typeof sessionId !== 'string' || announcedSessions.has(sessionId)) return
  announcedSessions.add(sessionId)
  log.info(`${LOG_TAG} 已接管 ${sessionId} 的 dsh 压缩(${what};provider=${deps.providerName}):`
    + '压缩由 CodeBuddy CLI 自行完成,dsh 不再压镜像消息')
}

/**
 * 该会话的上下文是否由 CodeBuddy CLI 拥有(按最新一次请求的路由 provider 判定)。
 * 用路由而不是会话映射:用户把 codebuddy 会话切回别的 provider 后,dsh 应当
 * 恢复自己压缩(映射记录此时仍在,不能作为判据)。
 */
function isCodebuddyOwned(deps: CompactCommandDeps, agent: CompactDelegableAgent): boolean {
  const provider = agent.session?.requestHeader?.()?.config?.provider
  return provider !== undefined && provider === deps.providerName
}

/** agent 的 maintenance 面(压缩期间占住它,使新消息排队而不是抢跑)。 */
interface MaintenanceAgentFace {
  runMaintenance?: <T>(job: (signal: AbortSignal) => Promise<T>) => Promise<T>
}

/**
 * 处理一次 /compact:codebuddy 会话转发 CLI,其它回落 dsh。
 * @param deps - 挂载依赖。
 * @param invocation - 命令调用。
 * @returns 命令结果。
 */
export async function handleCompactCommand(
  deps: CompactCommandDeps,
  invocation: CompactInvocation,
): Promise<CompactCommandResult> {
  if (invocation.rawInput.trim().length > 0) {
    return { kind: 'error', text: 'Usage: /compact (no arguments)' }
  }
  const sessionId = invocation.agent.session.id
  if (deps.conversations.get(sessionId) === undefined) return await dshCompact(deps, invocation)
  const cwd = invocation.agent.session.header.cwd ?? process.cwd()
  const agent = invocation.agent as unknown as MaintenanceAgentFace
  if (agent.runMaintenance === undefined) return await forwardCompactToCli(deps, sessionId, cwd, invocation.signal)
  // 必须在 agent 的 maintenance 相位里压缩(与 dsh 原生 compactNow 一致):
  // 否则压缩期间发来的消息会立刻开新回合抢跑,该轮请求与压缩并发写同一个
  // CLI 会话,把压缩结果盖掉(实测:压缩期间开的那轮之后 prompt 反而继续涨)。
  // 进 maintenance 后消息按原生行为排队(latch 到压缩结束再跑)。
  try {
    return await agent.runMaintenance(async (agentSignal) => {
      const signal = AbortSignal.any([agentSignal, invocation.signal])
      return await forwardCompactToCli(deps, sessionId, cwd, signal)
    })
  } catch {
    if (invocation.signal.aborted) return { kind: 'error', text: '压缩已取消。' }
    // runMaintenance 只在 agent 非 idle 时抛错。
    return { kind: 'error', text: '会话的回合正在运行中:等它结束后再压缩(避免与 CLI 的连接冲突)。' }
  }
}

/**
 * 在每个 agent 的 ctx 挂载 `compact` 命令(per-agent 覆盖全局注册)。
 * 没挂上的 agent 继续用全局的 command-compact。
 * @param deps - 挂载依赖。
 */
export function mountCompactCommand(deps: CompactCommandDeps): void {
  deps.ctx.inject(['commands'], (commandCtx: Context) => {
    commandCtx.on('agent/created', (payload: { agent: unknown }) => {
      // cordis 的服务访问必须在 inject 作用域内(直接读 agent.ctx.commands 会抛
      // "cannot get property \"commands\" without inject",并让 session/create 失败)。
      const agentCtx = (payload.agent as { ctx?: Context } | undefined)?.ctx
      if (agentCtx?.inject === undefined) return
      agentCtx.inject(['commands'], (scoped: Context) => {
        const face = scoped as unknown as { commands?: ScopedCommandsFace }
        if (face.commands?.register === undefined) return
        try {
          face.commands.register({
            name: 'compact',
            description: 'Compact conversation history (CodeBuddy sessions: sent to the CLI)',
            handler: invocation => handleCompactCommand(deps, invocation),
          })
        } catch { /* 重复挂载/名字冲突:保留全局命令 */ }
      })
    })
  })
}
