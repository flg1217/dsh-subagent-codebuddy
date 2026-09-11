/**
 * CodeBuddy ACP 连接层:JSON-RPC over stdio(ndjson)。
 *
 * 每个子代理委托一个 ACP 进程(`codebuddy --acp`),会话经 `session/new` /
 * `session/load` 复用;prompt 期间的生命周期(流式 update、协议级取消)由
 * CodeBuddy 官方 ACP 实现负责,替代此前自研的进程树管理与计时器猜测——
 * `session/cancel` 对生成流与正在执行的工具都是即时抢占(实测)。
 *
 * 活动语义(假死防御的关键,吸取 stderr 续命教训):
 * - **进展性事件**(agent_message_chunk / agent_thought_chunk / tool_call /
 *   tool_call_update)才重置动态空闲计时——它们代表任务真实推进;
 * - session_info_update / usage_update / config_option_update 等是 CLI 心跳,
 *   **不参与续命**,否则长思考/长工具期间的密集心跳会让死挂永不超时;
 * - stderr 只收集不续命,仅作错误归因证据。
 * @module subagent-codebuddy/acp
 */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'

/** 默认动态空闲超时预算:与 agy 执行器同一套算法(无总时长上限)。 */
export const DEFAULT_ACP_RUN_TIMEOUTS = {
  firstMs: 60_000,
  idleMinMs: 150_000,
  idleMaxMs: 600_000,
  idleFactor: 3,
  idleWarmupLines: 6,
  tailQuietMs: 5_000,
  tailBgQuietMs: 10 * 60_000,
  tailCapMs: 30 * 60_000,
}

/** 动态空闲超时预算(测试注入小值压缩时间)。 */
export interface AcpTimeouts {
  firstMs?: number
  idleMinMs?: number
  idleMaxMs?: number
  idleFactor?: number
  idleWarmupLines?: number
  /**
   * 在途工具期间的空闲硬顶(毫秒,默认 30 分钟;<=0 关闭)。
   * 正常长工具无心跳,空闲计时在工具在途时整体暂停;但工具**永不返回**
   * (CLI 卡死)+ 消费方被回收时,没有这层硬顶就会永久泄漏进程、
   * 子会话回合悬空(实测:侧边栏判定"目录损坏")。
   * 只咬「完全静默」的工具段——有任何中间 update 都会重置计时;超顶走
   * stall 重试(自动续跑),被误杀的工具通常工作已落盘,重跑代价可控。
   */
  guardCapMs?: number
  /**
   * 尾巴窗口静默阈值(毫秒,默认 5s;<=0 关闭尾巴窗口)。
   *
   * CLI 的 `end_turn` **不等于**空闲:后台任务(后台 bash / agent 任务)完成时
   * CLI 会自发续跑,续跑内容以普通 update 推过来。dsh 回合若已收尾,插件就不在
   * 抽流,这些内容全丢(实测量产场景:模型说"跑完我重启后端,给你最终结果",
   * 回合一结束 CLI 进程就被杀,承诺的收尾永远不来)。
   * 尾巴窗口:干净收尾后继续抽流,直到
   *   - `session_info_update._meta["codebuddy.ai/agentPhase"]` 报 `idle` 且静默
   *     达到本阈值(普通回合代价 = 这段静默);
   *   - 或收到 `session_end`(CLI 广播:会话真正空闲,含后台任务/团队收尾);
   *   - 或撞上 {@link AcpTimeouts.tailCapMs} 硬顶。
   */
  tailQuietMs?: number
  /**
   * 起了后台任务的回合的静默阈值(毫秒,默认 10 分钟)。
   *
   * 后台任务在跑时 CLI 可以长时间零 update(后台 `sleep 300` 之类),用普通
   * 阈值会在任务完成前就收尾。识别方式:落地的 `tool/call` 参数带
   * `run_in_background` / `background`(CLI Bash 的后台模式)。
   * 一旦看到**续跑内容**(settle 之后超过普通阈值才出现的内容 update),
   * 说明任务已回、CLI 在继续干活,阈值立即回到 {@link AcpTimeouts.tailQuietMs}。
   */
  tailBgQuietMs?: number
  /** 尾巴窗口硬顶(毫秒,默认 30 分钟):后台任务最长可拖着回合不闭合的时长。 */
  tailCapMs?: number
}

/** ACP session/update 里我们消费的 update 类型(其余类型仅作活动判定时忽略)。 */
export interface AcpUpdate {
  sessionUpdate: string
  content?: { type: string; text?: string }
  messageId?: string
  toolCallId?: string
  title?: string
  kind?: string
  status?: string
  rawInput?: Record<string, unknown>
  rawOutput?: { type: string; text?: string }
  /** CodeBuddy 私有扩展:工具名、参数完成标记等。 */
  _meta?: Record<string, unknown>
}

/** 一次 session/prompt 的收尾。 */
export interface AcpPromptResult {
  stopReason?: string
  errorMessage?: string
}

/** 进程退出信息。 */
export interface AcpExitInfo {
  code: number | null
  signal: string | null
}

/** 工具名在 _meta 私有扩展里的键。 */
const TOOL_NAME_META_KEY = 'codebuddy.ai/toolName'

/** 从 update 提取 CodeBuddy 私有工具名,并归一化为 dsh 工具名
 * (Read→read、TodoWrite→todo_write、WebSearch→web_search),
 * 让子代理窗口复用 dsh 原生工具的可视化渲染器。 */
export function toolNameOf(update: AcpUpdate): string {
  const name = update._meta?.[TOOL_NAME_META_KEY]
  const raw = typeof name === 'string' && name.length > 0 ? name : update.title ?? 'tool'
  return raw
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase()
}

/**
 * 从 `usage_update` 提取本次请求的用量(`_meta.usage`,OpenAI 风格字段)。
 *
 * 实测载荷:`prompt_tokens` / `completion_tokens` / `total_tokens` /
 * `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`,缓存命中还会镜像在
 * `prompt_tokens_details.cached_tokens`。映射到 dsh TokenUsage 的三个**不重叠**
 * 桶:未命中输入、缓存读、缓存写——命中桶优先取 OpenAI 风格的 hit 字段
 * (`cache_read_input_tokens` 在该载荷里恒为 0,不能优先)。
 * @param update - 一条 session/update。
 * @returns dsh 用量;载荷缺失或全零时为 undefined(心跳空载不计)。
 */
export function usageOfUpdate(update: AcpUpdate): TokenUsage | undefined {
  const payload = update._meta?.['usage'] ?? update._meta?.['codebuddy.ai/usage']
  if (typeof payload !== 'object' || payload === null) return undefined
  const record = payload as Record<string, unknown>
  const number = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
  const details = (key: string): Record<string, unknown> | undefined => {
    const value = record[key]
    return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
  }
  const prompt = number(record['prompt_tokens']) ?? 0
  const hit = number(record['prompt_cache_hit_tokens'])
    ?? number(details('prompt_tokens_details')?.['cached_tokens'])
    ?? number(record['cache_read_input_tokens'])
    ?? 0
  const input = number(record['prompt_cache_miss_tokens']) ?? Math.max(0, prompt - hit)
  const output = number(record['completion_tokens']) ?? 0
  if (prompt === 0 && output === 0 && hit === 0) return undefined
  const total = number(record['total_tokens'])
  const cacheWrite = number(record['cache_creation_input_tokens']) ?? number(record['prompt_cache_write_tokens'])
  const reasoning = number(details('completion_tokens_details')?.['reasoning_tokens'])
  return {
    inputTokens: input,
    outputTokens: output,
    ...(total === undefined ? {} : { totalTokens: total }),
    ...(hit === 0 ? {} : { cacheReadTokens: hit }),
    ...(cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
  }
}

/** 进展性事件:代表任务真实推进,重置动态空闲计时。 */
export function isProgressUpdate(update: AcpUpdate): boolean {
  return update.sessionUpdate === 'agent_message_chunk'
    || update.sessionUpdate === 'agent_thought_chunk'
    || update.sessionUpdate === 'tool_call'
    || update.sessionUpdate === 'tool_call_update'
}

/** 一个 ACP 进程连接:JSON-RPC 请求/通知 + update 事件回调。 */
export class AcpConnection {
  readonly proc: ChildProcess
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private exitInfo: AcpExitInfo | undefined
  private readonly exitWaiters: Array<(info: AcpExitInfo) => void> = []
  /** stderr 尾部(错误归因证据;只收集,不参与任何续命判定)。 */
  private stderrTail = ''
  /** close 原因:正常退出 / 被主动 kill(避免把自杀报成崩溃)。 */
  private killed = false

  constructor(
    argvPrefix: readonly string[],
    cwd: string,
    private readonly onUpdate: (update: AcpUpdate) => void,
  ) {
    // argvPrefix[0] 是可执行(如 node 或 CLI .exe),其余是前置参数(CLI 路径等)。
    this.proc = spawn(argvPrefix[0]!, [...argvPrefix.slice(1)], {
      cwd,
      // stdin 管道(发 JSON-RPC);stdout/stderr 管道(协议流 + 归因证据)。
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const rl = createInterface({ input: this.proc.stdout!, crlfDelay: Infinity })
    rl.on('line', line => {
      if (!line.trim().startsWith('{')) return
      let msg: {
        id?: number
        method?: string
        result?: unknown
        error?: unknown
        params?: { update?: AcpUpdate }
      }
      try { msg = JSON.parse(line) } catch { return }
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        const p = this.pending.get(msg.id)
        if (p !== undefined) {
          this.pending.delete(msg.id)
          if (msg.error !== undefined) p.reject(new Error(`ACP ${String((msg.error as { message?: string }).message ?? 'error')}`))
          else p.resolve(msg.result)
        }
        return
      }
      const update = msg.params?.update
      if (update !== undefined) this.onUpdate(update)
    })
    this.proc.stderr?.setEncoding('utf8')
    this.proc.stderr?.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4000)
    })
    this.proc.on('close', (code, signal) => {
      this.exitInfo = { code, signal: signal ?? null }
      // 进程退出时 reject 所有未决请求,避免悬挂到超时。
      for (const p of [...this.pending.values()]) p.reject(new Error('ACP 进程已退出'))
      this.pending.clear()
      for (const w of this.exitWaiters.splice(0)) w(this.exitInfo)
    })
  }

  /** 进程退出(含退出码);已在退出后调用则立即返回。 */
  onExit(listener: (info: AcpExitInfo) => void): void {
    if (this.exitInfo !== undefined) listener(this.exitInfo)
    else this.exitWaiters.push(listener)
  }

  /**
   * 发起一次 JSON-RPC 请求。
   * @param timeoutMs 超时毫秒;**<= 0 表示不设请求超时**——`session/prompt`
   * 这类长活请求(整个任务期间)必须传 0,它的生命周期由动态空闲超时
   * (cancel → kill → 进程退出 reject)与 abort 保护,固定超时会误杀长任务
   * (实测:默认 180s 把 3 分钟以上的子代理任务全部掐死)。
   */
  request<T>(method: string, params: Record<string, unknown>, timeoutMs = 180_000): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pending.delete(id)
          reject(new Error(`ACP ${method} 超时(${Math.round(timeoutMs / 1000)}s)${this.stderrNote()}`))
        }, timeoutMs)
      }
      this.pending.set(id, {
        resolve: v => { if (timer !== undefined) clearTimeout(timer); resolve(v as T) },
        reject: e => { if (timer !== undefined) clearTimeout(timer); reject(e) },
      })
      this.proc.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.proc.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  }

  /** stderr 尾部(有内容才带分号前缀)。 */
  stderrNote(): string {
    const tail = this.stderrTail.trim()
    return tail.length > 0 ? `;stderr: ${tail.slice(-500)}` : ''
  }

  /** 主动终止:标记自杀,避免 close 被误判为崩溃。 */
  kill(): void {
    this.killed = true
    try { this.proc.kill() } catch { /* 已退出 */ }
    try { this.proc.stdout?.destroy() } catch { /* 已关闭 */ }
  }

  get wasKilled(): boolean { return this.killed }
}
