/**
 * CodeBuddy 模型适配器:provider 路由 `codebuddy`,走 ACP(Agent Client Protocol)。
 *
 * 此前是 spawn `codebuddy -p` + 单向解析 stream-json:CLI 内部工具卡死时
 * 进程树杀不干净(工具子进程持有 stdout 写端),for-await 永久挂起,子代理
 * 假死且无任何错误反馈(实测,多机复现)。迁移到 ACP 后:
 *
 * - **会话生命周期官方化**:`session/new` / `session/load`(历史回放)复用
 *   长线会话;`session/prompt` 流式 `session/update`(含 thinking 流——
 *   单向 -p 模式没有的 agent_thought_chunk);
 * - **协议级取消**:`session/cancel` 对生成流与正在执行的工具都是即时抢占
 *   (实测),`stopReason: "cancelled"` 与正常结束明确区分;abort 信号驱动
 *   周期性重发(思考早期单次通知可能被吞);
 * - **静默失败自动重试**:CodeBuddy 服务端偶发静默失败(实测高频)——
 *   end_turn 但零思考零文本零工具、或只有思考没有产出。空跑会让主代理
 *   以为子代理完成了(用户看到"莫名中断、发继续没反应")。可重试失败
 *   自动恢复同一会话续跑(ACP session/load 回放),用尽才显式报错;
 * - **假死防御分层**:进展性 update(消息/思考/工具)重置动态空闲阈值;
 *   CLI 心跳(session_info/usage/config)与 stderr 不参与续命;静默超
 *   阈值先发 cancel、5s 仍无响应才 kill——进程退出码与 stderr 全程留证。
 * @module subagent-codebuddy/adapter
 */

import type { Context } from '@deepseek-ai/cordis'
import { ToolCallId, LlmAdapter, createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionSeq } from '@deepseek-ai/dsh-session'
import { buildPrompt } from './serialize.js'
import { AcpConnection, DEFAULT_ACP_RUN_TIMEOUTS, isProgressUpdate, toolNameOf } from './acp.js'
import type { AcpPromptResult, AcpTimeouts, AcpUpdate } from './acp.js'

/** 续跑指令:会话上下文已在 CLI 侧,只需告知"接着做"。 */
const CONTINUE_PROMPT = '继续完成之前未完成的任务。基于当前工作区状态继续,不要重复已完成的工作,只报告新做的内容。'

/** 可重试的委托失败:恢复同一会话续跑(ACP session/load)即可,不重复已完成部分。 */
class RetryableError extends Error {}

/** CodeBuddy CLI 入口配置(由 index.ts 解析)。 */
export interface CodebuddyAdapterOptions {
  /** 可执行入口(node 脚本绝对路径或命令)。 */
  command: string
  /** 前置参数(如解析出的 CLI 路径)。 */
  prefixArgs: string[]
  /** 读取当前默认模型(调用时求值,设置面板改默认模型后对新请求实时生效)。 */
  modelOf: () => string
  /** 传给 `--permission-mode` 的权限模式。 */
  permissionMode: string
  /** 追加的额外 CodeBuddy 参数。 */
  extraArgs: string[]
  /** 动态空闲超时预算(可选,默认见 {@link DEFAULT_ACP_RUN_TIMEOUTS})。 */
  timeouts?: AcpTimeouts
  /** 静默失败自动重试次数(默认 2:首次 + 1 次续跑)。 */
  maxAttempts?: number
  /** 重试间隔(毫秒,默认 3s)。 */
  retryDelayMs?: number
}

/**
 * 续跑时的增量 prompt。
 *
 * 会话历史已由 CodeBuddy 的会话存储持有(`session/load`),重复整段历史会
 * 浪费上下文并让模型误以为要重做;因此只发最后一条用户消息(续聊的新
 * 输入),没有就退回通用续跑指令。
 */
function resumePrompt(messages: readonly GenerateOptions['messages'][number][]): string {
  const last = [...messages].reverse().find(message => message.role === 'user')
  if (last === undefined) return CONTINUE_PROMPT
  const text = last.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join('')
  return text.trim().length > 0 ? text : CONTINUE_PROMPT
}

/**
 * CodeBuddy 模型适配器。stream() 每次调用:
 * spawn `codebuddy --acp` → initialize → session/new(或 session/load 复用)
 * → session/prompt → 消费 session/update(思考/文本/工具)→ finish 收尾。
 * 每次调用一个 ACP 进程,用完退出;会话连续性由 CodeBuddy 会话存储 +
 * session/load 保证(实测回放完整);静默失败自动恢复会话续跑。
 */
export class CodebuddyLlmAdapter extends LlmAdapter {
  /**
   * dsh 子代理会话 → CodeBuddy ACP sessionId。
   *
   * 首次调用 `session/new` 建立并记录;之后同一子代理会话的每次 stream 都
   * `session/load` 载入同一会话(官方实现会先回放历史事件,回放不落地)。
   */
  private readonly conversationIds = new Map<string, string>()

  constructor(
    private readonly ctx: Context,
    private readonly options: CodebuddyAdapterOptions,
  ) {
    super()
  }

  /**
   * 绑定模型元数据与分发流入口(rc.2+ 的 LlmAdapter 接口)。
   * 显式实现而非依赖基类:插件对宿主 dsh-llm 版本保持兼容
   * (rc.6 宿主不调用此方法;rc.2+ 宿主调用本实现)。
   */
  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{
    model: LlmResolvedModelInfo
    stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>
  }> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options) => this.stream(options),
    }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield* this.streamWithRetry(options)
  }

  /**
   * 带重试的委托执行。可重试失败(静默空跑/半途终止/进程退出/超时)时
   * 恢复同一会话续跑;用尽后以显式错误收尾,让主代理知道子代理实际状态。
   */
  private async *streamWithRetry(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const maxAttempts = this.options.maxAttempts ?? 2
    const retryDelayMs = this.options.retryDelayMs ?? 3_000
    // 会话级 step 状态跨 attempt 连续(重试的续跑是同一子代理任务的延续)。
    const stepState = { stepped: false, toolCallSeqs: new Map<string, SessionSeq>() }

    for (let attempt = 1; ; attempt++) {
      const isLast = attempt >= maxAttempts
      try {
        yield* this.streamOnce(options, attempt, stepState)
        return
      } catch (error) {
        if (options.signal?.aborted) return
        if (!(error instanceof RetryableError) || isLast) {
          yield {
            type: 'finish',
            reason: {
              kind: 'error',
              failure: {
                message: (error instanceof Error ? error.message : String(error)).slice(0, 500),
                code: 'CODEBUDDY_EXEC_ERROR',
              },
            },
          }
          return
        }
        await new Promise<void>(resolve => setTimeout(resolve, retryDelayMs))
        if (options.signal?.aborted) return
      }
    }
  }

  /** 单次委托尝试:进程 + 握手 + prompt + update 消费。 */
  private async *streamOnce(
    options: GenerateOptions,
    attempt: number,
    stepState: { stepped: boolean; toolCallSeqs: Map<string, SessionSeq> },
  ): AsyncIterable<StreamChunk> {
    const { command, prefixArgs } = this.options
    // 请求级 model 优先(子代理可经 agentOptions.model 动态指定),回退到当前默认模型。
    const model = options.model ?? this.options.modelOf()
    // 会话复用:同一子代理会话映射到同一个 CodeBuddy ACP sessionId。
    const dshSessionId = options.sessionId
    const existing = dshSessionId === undefined ? undefined : this.conversationIds.get(dshSessionId)
    const isResume = existing !== undefined
    // 首次 attempt 用完整任务 prompt;重试 attempt 发续跑指令(历史已载入)。
    const serialized = isResume || attempt > 1
      ? { prompt: attempt > 1 ? CONTINUE_PROMPT : resumePrompt(options.messages), cleanup: async (): Promise<void> => {} }
      : await buildPrompt(this.ctx, options)
    const { prompt, cleanup } = serialized

    // 工作目录对齐子代理会话的工作区,保证文件操作发生在正确目录。
    const childSession = options.sessionId !== undefined ? this.ctx.get('sessions')?.get(options.sessionId) : undefined
    const cwd = childSession?.header.cwd ?? process.cwd()

    try {
      // ── update 泵:回调把 update 推进队列,generator 在此处消费 ─────────
      // capturing 期间(initialize/new/load 完成之前)的 update 全部丢弃——
      // session/load 会同步回放历史事件,不能落地成新内容。
      let capturing = true
      const queue: AcpUpdate[] = []
      let wake: (() => void) | undefined
      const onUpdate = (update: AcpUpdate): void => {
        if (capturing) return
        queue.push(update)
        const w = wake
        wake = undefined
        w?.()
      }
      const waitForUpdate = async (): Promise<void> => {
        if (queue.length > 0) return
        await new Promise<void>(resolve => { wake = resolve })
      }

      // ── 动态空闲超时:进展性 update 续命;两段收尾(cancel → kill) ──────
      const to = { ...DEFAULT_ACP_RUN_TIMEOUTS, ...this.options.timeouts }
      const startedAt = Date.now()
      let stallTimedOut = false
      let firstTimer: ReturnType<typeof setTimeout> | undefined
      let idleTimer: ReturnType<typeof setTimeout> | undefined
      let killTimer: ReturnType<typeof setTimeout> | undefined
      let maxGapMs = 0
      let lastProgressAt = startedAt
      let progressSamples = 0
      let lastBudgetMs = to.idleMaxMs
      let acpSessionId = ''
      let textLanded = 0
      const kill = (): void => { try { conn.kill() } catch { /* 已退出 */ } }
      const failStall = (): void => {
        stallTimedOut = true
        // 第一段:协议级取消(CLI 事件循环若还活着就能收尾)。
        if (acpSessionId !== '') conn.notify('session/cancel', { sessionId: acpSessionId })
        // 第二段:5s 仍无响应才杀进程——纯死挂只有这一条路。
        if (killTimer === undefined) killTimer = setTimeout(kill, 5_000)
      }
      const touch = (): void => {
        if (firstTimer !== undefined) {
          clearTimeout(firstTimer)
          firstTimer = undefined
        }
        if (idleTimer !== undefined) clearTimeout(idleTimer)
        idleTimer = setTimeout(failStall, lastBudgetMs)
      }
      const armIdle = (): void => {
        const now = Date.now()
        maxGapMs = Math.max(maxGapMs, now - lastProgressAt)
        lastProgressAt = now
        progressSamples += 1
        lastBudgetMs = progressSamples <= to.idleWarmupLines
          ? to.idleMaxMs
          : Math.min(Math.max(maxGapMs * to.idleFactor, to.idleMinMs), to.idleMaxMs)
        touch()
      }

      // ── 会话事件落地:turn/step 管理(跨 attempt 连续) ───────────────────
      const session = options.sessionId !== undefined ? this.ctx.get('sessions')?.get(options.sessionId) : undefined
      const events = session?.ownEvents?.() ?? []
      const turn = ([...events].reverse().find(e => e.type === 'turn/start')?.data.turn ?? 1) as number
      let step: number = ([...events].reverse().find(e => e.type === 'step/start')?.data.step ?? 1) as number
      let stepOpen = !stepState.stepped
      const openNextStep = (): void => {
        step += 1
        session?.append('step/start', { turn, step })
        stepOpen = true
      }
      const ensureStep = (): void => {
        if (session === undefined) return
        if (!stepState.stepped) {
          // 首次落地:闭合 agent-loop 的初始 step,再从下一个 step 开始。
          stepState.stepped = true
          closeStep()
          openNextStep()
          return
        }
        if (stepOpen) return
        openNextStep()
      }
      const closeStep = (): void => {
        if (!stepOpen || session === undefined) return
        session.append('step/end', { turn, step })
        stepOpen = false
      }
      const pendingToolCalls = new Map<string, { name: string; rawInput: Record<string, unknown>; landed: boolean }>()
      let pendingBlocks: ContentBlock[] = []
      let currentStream: {
        messageId: string
        blockType: 'text' | 'reasoning'
        index: number
        text: string
        chunks: StreamChunk[]
      } | undefined
      let nextBlockIndex = 0

      /** 落地已累积的流(块收尾 + assistant/chunk + assistant/message)。 */
      const flushPending = (): void => {
        if (currentStream === undefined) return
        const { index, text, chunks, blockType } = currentStream
        const closed: StreamChunk[] = [...chunks, {
          type: 'block-end',
          index,
          block: blockType === 'text' ? { type: 'text', text } : { type: 'reasoning', text },
        }]
        currentStream = undefined
        if (session === undefined) return
        ensureStep()
        const seqs = closed.map(chunk => session.append('assistant/chunk', { turn, step, chunk }).seq)
        if (text.length > 0) {
          pendingBlocks.push(blockType === 'text' ? { type: 'text', text } : { type: 'reasoning', text })
          session.append('assistant/message', {
            turn,
            step,
            message: createAssistantMessage({
              content: pendingBlocks,
              source: { provider: options.provider ?? 'codebuddy', model },
            }),
          }, { surfaceOp: 'append', sourceEventSeqs: seqs })
          pendingBlocks = []
          if (blockType === 'text') textLanded += 1
        }
      }

      /** 处理一条 ACP update:续命 + 会话事件落地 + 流累积。 */
      const handleUpdate = (update: AcpUpdate): void => {
        if (isProgressUpdate(update)) armIdle()
        switch (update.sessionUpdate) {
          case 'agent_thought_chunk':
          case 'agent_message_chunk': {
            const text = update.content?.text ?? ''
            if (text.length === 0) return
            const blockType = update.sessionUpdate === 'agent_thought_chunk' ? 'reasoning' : 'text'
            const messageId = update.messageId ?? `${blockType}-anonymous`
            if (currentStream === undefined || currentStream.messageId !== messageId || currentStream.blockType !== blockType) {
              flushPending()
              currentStream = {
                messageId,
                blockType,
                index: nextBlockIndex++,
                text: '',
                chunks: [{ type: 'block-start', index: nextBlockIndex - 1, blockType }],
              }
            }
            currentStream.text += text
            currentStream.chunks.push({ type: 'text-delta', index: currentStream.index, text })
            return
          }
          case 'tool_call': {
            if (update.toolCallId === undefined) return
            const name = toolNameOf(update)
            const rawInput = update.rawInput ?? {}
            // 参数完整性:in_progress 阶段 rawInput 是空壳(参数流式生成中),
            // 等 pending(toolArgumentsComplete)再落地——否则 UI 只能看到 {}。
            const complete = update._meta?.['codebuddy.ai/toolArgumentsComplete'] === true
              || update.status === 'pending'
            const known = pendingToolCalls.get(update.toolCallId)
            if (known === undefined) {
              pendingToolCalls.set(update.toolCallId, { name, rawInput, landed: false })
              if (!complete) return
            }
            const entry = pendingToolCalls.get(update.toolCallId)!
            if (entry.landed) return
            entry.landed = true
            entry.rawInput = Object.keys(entry.rawInput).length > 0 ? entry.rawInput : rawInput
            flushPending()
            ensureStep()
            const ev = session?.append('tool/call', {
              turn,
              step,
              callId: ToolCallId(update.toolCallId),
              name: entry.name,
              arguments: JSON.stringify(entry.rawInput),
            })
            if (ev !== undefined) stepState.toolCallSeqs.set(update.toolCallId, ev.seq)
            return
          }
          case 'tool_call_update': {
            if (update.toolCallId === undefined) return
            if (update.status !== 'completed' && update.status !== 'failed') return
            let known = pendingToolCalls.get(update.toolCallId)
            if (known === undefined) {
              // 兜底:call 事件从未落地(缺 pending 直达 completed 的路径),
              // 用 update 自带的 rawInput 补落,保证 tool/result 总有配对的 call。
              known = { name: toolNameOf(update), rawInput: update.rawInput ?? {}, landed: false }
              pendingToolCalls.set(update.toolCallId, known)
            }
            if (!known.landed) {
              known.landed = true
              flushPending()
              ensureStep()
              const ev = session?.append('tool/call', {
                turn,
                step,
                callId: ToolCallId(update.toolCallId),
                name: known.name,
                arguments: JSON.stringify(known.rawInput),
              })
              if (ev !== undefined) stepState.toolCallSeqs.set(update.toolCallId, ev.seq)
            }
            pendingToolCalls.delete(update.toolCallId)
            const outputText = update.rawOutput?.text ?? ''
            flushPending()
            const seq = stepState.toolCallSeqs.get(update.toolCallId)
            session?.append('tool/result', {
              turn,
              step,
              message: createToolResultMessage({
                callId: ToolCallId(update.toolCallId),
                content: [{ type: 'text', text: outputText.slice(0, 2000) }],
                isError: update.status === 'failed',
              }),
            }, {
              surfaceOp: 'append',
              ...(seq !== undefined ? { sourceEventSeqs: [seq] } : {}),
            })
            // 本轮到此结束:闭合 step,下一轮内容在新 step 里落地。
            closeStep()
            return
          }
          default:
            return
        }
      }

      // ── 建 ACP 进程 + 握手 + 会话 ────────────────────────────────────────
      const conn = new AcpConnection(
        [command, ...prefixArgs, '--acp', '--model', model, '--dangerously-skip-permissions', ...this.options.extraArgs],
        cwd,
        onUpdate,
      )
      touch()
      let exitError: Error | undefined
      conn.onExit(info => {
        if (conn.wasKilled || stallTimedOut) return
        exitError = new Error(
          `CodeBuddy ACP 进程退出(code ${info.code ?? 'null'}${info.signal !== null ? `,signal ${info.signal}` : ''})${conn.stderrNote()}`,
        )
        const w = wake
        wake = undefined
        w?.()
      })

      // abort → 周期性 session/cancel(思考早期单次通知可能被吞,实测)。
      let cancelLoopTimer: ReturnType<typeof setInterval> | undefined
      const onAbort = (): void => {
        cancelLoopTimer = setInterval(() => {
          if (acpSessionId !== '') conn.notify('session/cancel', { sessionId: acpSessionId })
        }, 1_000)
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })

      try {
        await conn.request('initialize', {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        }, to.firstMs)

        if (isResume && existing !== undefined) {
          // 历史回放:load 响应前的 update 已被 capturing 丢弃。
          await conn.request('session/load', { sessionId: existing, cwd, mcpServers: [] })
          acpSessionId = existing
        } else {
          const created = await conn.request<{ sessionId: string }>('session/new', { cwd, mcpServers: [] }, to.firstMs)
          acpSessionId = created.sessionId
          if (dshSessionId !== undefined) this.conversationIds.set(dshSessionId, acpSessionId)
        }
        capturing = false

        // ── prompt:消费 update 直到响应到达 ────────────────────────────────
        let promptResult: AcpPromptResult | undefined
        let promptError: Error | undefined
        const promptPromise = conn.request<{ stopReason?: string; errorMessage?: string }>(
          'session/prompt',
          { sessionId: acpSessionId, prompt: [{ type: 'text', text: prompt }] },
        ).then(
          v => { promptResult = v },
          e => { promptError = e instanceof Error ? e : new Error(String(e)) },
        )

        while (promptResult === undefined && promptError === undefined && exitError === undefined && !stallTimedOut) {
          while (queue.length > 0) {
            const update = queue.shift()
            if (update !== undefined) handleUpdate(update)
          }
          if (promptResult !== undefined || promptError !== undefined || exitError !== undefined || stallTimedOut) break
          await Promise.race([waitForUpdate(), new Promise<void>(resolve => setTimeout(resolve, 100))])
        }
        // 抽干尾巴(cancel/exit 后可能还有少量 update)。
        while (queue.length > 0) {
          const update = queue.shift()
          if (update !== undefined) handleUpdate(update)
        }

        // 失败分类:可重试的走 RetryableError(外层恢复会话续跑)。
        if (stallTimedOut) {
          throw new RetryableError(`CodeBuddy ACP 调用超时(已等待 ${Math.round((Date.now() - startedAt) / 1000)}s;`
            + `静默超过 ${Math.round(lastBudgetMs / 1000)}s 无进展,本次历史最大进展间隔 ${Math.round(maxGapMs / 1000)}s,`
            + `阈值 = clamp(间隔 × ${to.idleFactor}, ${Math.round(to.idleMinMs / 1000)}s, ${Math.round(to.idleMaxMs / 1000)}s),`
            + `已收 ${progressSamples} 次进展${conn.stderrNote()})`)
        }
        if (promptError !== undefined) throw new RetryableError(`CodeBuddy ACP 请求失败:${promptError.message}${conn.stderrNote()}`)
        if (exitError !== undefined) throw exitError
        if (options.signal?.aborted === true) {
          flushPending()
          closeStep()
          return
        }

        const stopReason = promptResult?.stopReason
        const errorMessage = promptResult?.errorMessage
        flushPending()
        closeStep()
        if (errorMessage !== undefined && errorMessage.length > 0) {
          throw new RetryableError(`CodeBuddy 报错:${errorMessage.slice(0, 300)}${conn.stderrNote()}`)
        }
        // 静默失败防御(实测高频):end_turn 但零思考、零文本、零工具——多为
        // 配额受限/服务端异常导致的静默失败;或只有思考没有产出(半途失败)。
        // 空跑会让主代理以为子代理完成了,用户看到"莫名中断"。
        if (stopReason !== 'cancelled' && (progressSamples === 0 || textLanded === 0)) {
          throw new RetryableError(`CodeBuddy 静默失败(stopReason: ${stopReason ?? 'none'};`
            + `${progressSamples} 次进展、0 次文本产出)——可能是配额受限或服务端异常`)
        }
        // end_turn + 有文本产出,或 cancelled:正常收尾。
        yield { type: 'finish', reason: { kind: 'stop' } }
        void stopReason
      } finally {
        if (firstTimer !== undefined) clearTimeout(firstTimer)
        if (idleTimer !== undefined) clearTimeout(idleTimer)
        if (killTimer !== undefined) clearTimeout(killTimer)
        if (cancelLoopTimer !== undefined) clearInterval(cancelLoopTimer)
        options.signal?.removeEventListener('abort', onAbort)
        conn.kill()
      }
    } finally {
      await cleanup()
    }
  }

  override resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      // CodeBuddy 由内置模型驱动,支持文本与图像输入。
      inputModalities: ['text', 'image'],
      context: { contextWindow: 1_000_000 },
    })
  }
}
