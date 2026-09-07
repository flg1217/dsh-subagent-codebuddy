/**
 * CodeBuddy 模型适配器:provider 路由 `codebuddy`。
 * 对齐 llm-agy/adapter.ts 的结构:LLM 适配器负责 spawn 上游 + 用翻译模块
 * 产出 StreamChunk;CodeBuddy 的工具步骤落地为子代理会话事件
 * (tool/call + tool/result)。
 * @module subagent-codebuddy/adapter
 */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import type { Context } from '@deepseek-ai/cordis'
import { ToolCallId, LlmAdapter, createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionSeq } from '@deepseek-ai/dsh-session'
import { buildPrompt } from './serialize.js'
import { CodebuddyTranslator } from './translate.js'

/** 续跑指令:会话上下文已在 CLI 侧,只需告知"接着做"。 */
const CONTINUE_PROMPT = '继续完成之前未完成的任务。基于当前工作区状态继续,不要重复已完成的工作,只报告新做的内容。'

/**
 * 续跑时的增量 prompt。
 *
 * 会话历史已由 CodeBuddy 的会话存储持有(`--resume`),重复整段历史会
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

/** 适配器配置(由 index.ts 传入)。 */
export interface CodebuddyAdapterOptions {
  /** 可 spawn 的可执行文件(Windows 下已解析为 node + CLI 路径)。 */
  command: string
  /** 前置参数(如解析出的 CLI 路径)。 */
  prefixArgs: string[]
  /** 读取当前默认模型(调用时求值,设置面板改默认模型后对新请求实时生效)。 */
  modelOf: () => string
  /** 传给 `--permission-mode` 的权限模式。 */
  permissionMode: string
  /** 追加的额外 CodeBuddy 参数。 */
  extraArgs: string[]
  /**
   * 超时预算(动态自适应,默认见 {@link DEFAULT_CODEBUDDY_RUN_TIMEOUTS});
   * 测试注入小值以便压缩时间。
   */
  timeouts?: {
    firstMs?: number
    idleMinMs?: number
    idleMaxMs?: number
    idleFactor?: number
    idleWarmupLines?: number
  }
}

/** 默认超时预算(与 llm-agy 执行器同一套动态算法):CodeBuddy 深度思考期间
 * stream-json 可以长时间不出行(整条 assistant 消息完成后才输出,流式思考
 * 在本地不落任何记录),固定阈值必然误杀——故按本次调用已观测的最大行间隔
 * 自适应,热身行数内一律 idleMaxMs 宽容,样本足够后收紧到
 * clamp(最大间隔 × factor, min, max)。无总时长上限,有输出即续期。 */
export const DEFAULT_CODEBUDDY_RUN_TIMEOUTS = {
  firstMs: 60_000,
  idleMinMs: 150_000,
  idleMaxMs: 600_000,
  idleFactor: 3,
  idleWarmupLines: 6,
}

/** 进程退出兜底:进程卡死时强制结束,保证 stream 一定结束。 */
async function closeWithTimeout(
  proc: ChildProcess,
  signal: AbortSignal | undefined,
  timeoutMs = 30_000,
): Promise<[number | null, string | null]> {
  const closePromise = once(proc, 'close') as Promise<[number | null, string | null]>
  let timer: ReturnType<typeof setTimeout> | undefined
  if (signal?.aborted) {
    proc.kill()
  } else {
    timer = setTimeout(() => {
      proc.kill()
    }, timeoutMs)
  }
  try {
    return await closePromise
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * CodeBuddy 模型适配器。stream() 每次调用:
 * 序列化 prompt → spawn `codebuddy -p ... --output-format stream-json`
 * → 逐行翻译为 StreamChunk(完整消息,非增量)→ 工具步骤落地为会话事件
 * → usage/finish 收尾。
 *
 * 子代理会话的续聊由 dsh 侧管理:每次调用都把该子代理自己的完整历史
 * 序列化进 prompt,不依赖 CodeBuddy 的会话存储。
 */
export class CodebuddyLlmAdapter extends LlmAdapter {
  /**
   * dsh 子代理会话 → CodeBuddy 会话 id。
   *
   * 首次调用用 `--session-id` 固定会话 id;之后同一子代理会话的每次
   * stream 都用 `--resume` 续跑同一会话,这样 CodeBuddy 侧的上下文是连
   * 续的,续聊时不必把整段历史重新塞进 prompt。
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
    const { command, prefixArgs, permissionMode } = this.options
    // 请求级 model 优先(子代理可经 agentOptions.model 动态指定),回退到当前默认模型。
    const model = options.model ?? this.options.modelOf()
    // 会话续跑:同一子代理会话复用同一个 CodeBuddy 会话 id。
    // 首次用 --session-id 固定 id,之后用 --resume 续跑,CodeBuddy 侧的
    // 上下文保持连续,续聊时不必把整段历史重新塞进 prompt。
    const dshSessionId = options.sessionId
    const existing = dshSessionId === undefined ? undefined : this.conversationIds.get(dshSessionId)
    const isResume = existing !== undefined
    const conversationId = existing ?? (dshSessionId === undefined ? undefined : `dsh-${dshSessionId}`)
    if (conversationId !== undefined && dshSessionId !== undefined) {
      this.conversationIds.set(dshSessionId, conversationId)
    }
    const sessionArgs = conversationId === undefined
      ? []
      : isResume ? ['--resume', conversationId] : ['--session-id', conversationId]
    const serialized = isResume
      ? { prompt: resumePrompt(options.messages), cleanup: async (): Promise<void> => {} }
      : await buildPrompt(this.ctx, options)
    const { prompt, cleanup } = serialized

    // 工作目录对齐子代理会话的工作区,保证文件操作发生在正确目录。
    const childSession = options.sessionId !== undefined ? this.ctx.get('sessions')?.get(options.sessionId) : undefined
    const cwd = childSession?.header.cwd ?? process.cwd()

    try {
      const proc: ChildProcess = spawn(command, [
        ...prefixArgs,
        ...sessionArgs,
        '-p', prompt,
        '--output-format', 'stream-json',
        '--permission-mode', permissionMode,
        '--model', model,
        ...this.options.extraArgs,
      ], {
        cwd,
        // stderr 收为管道:CLI 的重试/进度日志走这里,收集尾部用于错误归因。
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      if (proc.stdout === null) {
        proc.kill()
        throw new Error('subagent-codebuddy: codebuddy process has no stdout stream')
      }

      // CLI 自己的错误信号:退出码。正常完成 code 0;崩溃/自报失败非 0——
      // 流结束后按退出码立即报错并附 stderr 尾巴,而不是靠计时器猜。
      let exitCode: number | null | undefined
      let exitSignal: string | undefined
      proc.on('close', (code, signal) => {
        exitCode = code
        exitSignal = signal ?? undefined
      })

      const onAbort = (): void => { proc.kill() }
      options.signal?.addEventListener('abort', onAbort, { once: true })

      // 工具步骤落地为会话事件所需的 turn/step(从子代理会话推断)。
      const session = options.sessionId !== undefined ? this.ctx.get('sessions')?.get(options.sessionId) : undefined
      const events = session?.ownEvents?.() ?? []
      const turn = ([...events].reverse().find(e => e.type === 'turn/start')?.data.turn ?? 1) as number
      let step = ([...events].reverse().find(e => e.type === 'step/start')?.data.step ?? 1) as number
      // CodeBuddy 一次进程内要跑很多轮(文本→工具→文本→工具…),而 dsh 的
      // assistant-step 节点是按 step 聚合的:全都塞进同一个 step 会让所有
      // 文本聚成一个节点、所有 tool 节点被排到它前面,显示顺序与真实发生
      // 顺序不符。这里每轮工具执行完就闭合当前 step、开启下一个,让每一
      // 轮拿到自己的 step,从而与 tool 节点交错排序。
      // 初始 step 由 agent-loop 开启,故起始为 open。
      let stepOpen = true
      // agent-loop 会在流结束后往**它自己的初始 step** 再 append 一条最终
      // assistant/message。本适配器不 yield 文本给它(见流末说明),那条
      // message 就是空的;但即便为空,它也会把初始 step 的 assistant-step
      // 节点 anchorSeq 顶到最大、排到会话末尾。所以初始 step 整个让给
      // agent-loop,本进程的各轮从下一个 step 开始记录。
      let stepped = false
      const openNextStep = (): void => {
        step += 1
        session?.append('step/start', { turn, step })
        stepOpen = true
      }
      const ensureStep = (): void => {
        if (session === undefined) return
        if (!stepped) {
          // 首次落地:闭合 agent-loop 的初始 step,再从下一个 step 开始。
          // (初始 stepOpen 为 true,所以这一步必须放在 stepOpen 判断之前。)
          stepped = true
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
      const toolCallSeqs = new Map<string, SessionSeq>()
      // 消息落地:CodeBuddy 一次进程输出多轮(文本→工具→文本→工具),
      // 若把文本 chunk 交给 agent-loop,它会把整个 stream 的文本聚合为
      // 一条消息堆在末尾(工具事件之后),显示顺序错乱。因此适配器
      // 自己按到达顺序落地 assistant/message:工具调用前 flush 已累积文本。
      // 流末剩余文本不自己落地,而是 yield 给 agent-loop——agent-loop 在
      // 流结束后总会 append 一条 assistant/message(聚合整个 stream 的 yield
      // 文本),若其为空,UI 实时渲染会把已显示的 blocks 覆盖为空
      // (assistant-step 节点按 step 聚合,最后一条 message 胜出)。
      let pendingBlocks: ContentBlock[] = []
      let pendingChunks: StreamChunk[] = []
      const flushText = (): void => {
        if (session === undefined || pendingBlocks.length === 0) return
        ensureStep()
        const seqs = pendingChunks.map(chunk =>
          session.append('assistant/chunk', { turn, step, chunk }).seq)
        session.append('assistant/message', {
          turn,
          step,
          message: createAssistantMessage({
            content: pendingBlocks,
            source: { provider: options.provider ?? 'codebuddy', model },
          }),
        }, { surfaceOp: 'append', sourceEventSeqs: seqs })
        pendingBlocks = []
        pendingChunks = []
      }

      // 动态空闲超时(与 llm-agy 执行器同一套算法):CodeBuddy 深度思考/
      // 长工具执行期间 stream-json 可以长时间不出行——流式思考在本地不落
      // 任何记录,固定阈值必然误杀。stdout 每行重置静默计时并采样;静默
      // 阈值按本次调用已观测的最大行间隔自适应 clamp(最大间隔 × factor,
      // min, max),热身行数内一律 idleMaxMs 宽容(任务早期的历史间隔还
      // 不足以预测后续的长静默)。无总时长上限——有输出就永远续期。
      const to = { ...DEFAULT_CODEBUDDY_RUN_TIMEOUTS, ...this.options.timeouts }
      const startedAt = Date.now()
      let idleTimedOut = false
      let firstTimer: ReturnType<typeof setTimeout> | undefined
      let idleTimer: ReturnType<typeof setTimeout> | undefined
      let maxGapMs = 0
      let lastLineAt = startedAt
      let lineSamples = 0
      let lastBudgetMs = to.idleMaxMs
      const failIdle = (): void => {
        idleTimedOut = true
        try { proc.kill() } catch { /* 已退出 */ }
        // 进程树残留可能仍持有 stdout 写端,必须同时关流,for-await 才能结束。
        try { proc.stdout?.destroy() } catch { /* 已关闭 */ }
      }
      const touch = (): void => {
        // 续命:按当前预算重置静默计时;首个活动同时撤销首包超时。
        if (firstTimer !== undefined) {
          clearTimeout(firstTimer)
          firstTimer = undefined
        }
        if (idleTimer !== undefined) clearTimeout(idleTimer)
        idleTimer = setTimeout(failIdle, lastBudgetMs)
      }
      const armIdle = (): void => {
        const now = Date.now()
        maxGapMs = Math.max(maxGapMs, now - lastLineAt)
        lastLineAt = now
        lineSamples += 1
        lastBudgetMs = lineSamples <= to.idleWarmupLines
          ? to.idleMaxMs
          : Math.min(Math.max(maxGapMs * to.idleFactor, to.idleMinMs), to.idleMaxMs)
        touch()
      }
      touch()

      // stderr 活动(CLI 重试/进度日志)只续命不采样:密集日志不应把
      // stdout 行间隔样本污染收紧,但它确实证明进程活着。
      let stderrTail = ''
      if (proc.stderr !== null && proc.stderr !== undefined) {
        proc.stderr.setEncoding('utf8')
        proc.stderr.on('data', (chunk: string) => {
          stderrTail = (stderrTail + chunk).slice(-4000)
          touch()
        })
      }

      const translator = new CodebuddyTranslator()
      try {
        proc.stdout.setEncoding('utf8')
        const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity })
        for await (const line of rl) {
          if (options.signal?.aborted) {
            proc.kill()
            break
          }
          // 还在出活就续命:只在长时间无输出时才按卡死处理。
          armIdle()
          const { chunks, toolSteps } = translator.push(line)
          for (const chunk of chunks) {
            if (chunk.type === 'block-start' || chunk.type === 'text-delta' || chunk.type === 'block-end') {
              // 文本类 chunk:累积,由 flushText 落地为 assistant/chunk + message。
              if (chunk.type === 'block-end') {
                pendingBlocks.push(chunk.block)
              }
              pendingChunks.push(chunk)
              continue
            }
            yield chunk
          }
          for (const stepEvent of toolSteps) {
            if (session === undefined) continue
            if (stepEvent.kind === 'tool/call') {
              // 工具调用前先落地已累积文本,保证"文本→工具"顺序。
              flushText()
              ensureStep()
              const ev = session.append('tool/call', {
                turn,
                step,
                callId: ToolCallId(stepEvent.callId),
                name: stepEvent.name ?? 'tool',
                arguments: stepEvent.argumentsJson ?? '{}',
              })
              toolCallSeqs.set(stepEvent.callId, ev.seq)
            } else {
              const seq = toolCallSeqs.get(stepEvent.callId)
              session.append('tool/result', {
                turn,
                step,
                message: createToolResultMessage({
                  callId: ToolCallId(stepEvent.callId),
                  content: [{ type: 'text', text: stepEvent.outputText ?? '' }],
                  isError: stepEvent.isError ?? false,
                }),
              }, {
                surfaceOp: 'append',
                ...(seq !== undefined ? { sourceEventSeqs: [seq] } : {}),
              })
              // 本轮到此结束:闭合 step,下一轮内容会在新 step 里落地。
              closeStep()
            }
          }
        }
      } finally {
        options.signal?.removeEventListener('abort', onAbort)
        if (firstTimer !== undefined) clearTimeout(firstTimer)
        if (idleTimer !== undefined) clearTimeout(idleTimer)
      }

      await closeWithTimeout(proc, options.signal)
      // CLI 没来得及自报就死掉的两类:静默死挂(动态超时)与异常退出码。
      // 流内 result.is_error 已由 translator 走 finish error,不在此重复。
      const stderrNote = stderrTail.trim().length > 0
        ? `;stderr: ${stderrTail.trim().slice(-500)}`
        : ''
      if (idleTimedOut) {
        throw new Error(`CodeBuddy 调用超时(已等待 ${Math.round((Date.now() - startedAt) / 1000)}s;`
          + `静默超过 ${Math.round(lastBudgetMs / 1000)}s 无输出,本次历史最大行间隔 ${Math.round(maxGapMs / 1000)}s,`
          + `阈值 = clamp(间隔 × ${to.idleFactor}, ${Math.round(to.idleMinMs / 1000)}s, ${Math.round(to.idleMaxMs / 1000)}s),`
          + `已收 ${lineSamples} 行${lineSamples === 0 ? '(首包未到)' : ''})${stderrNote}`)
      }
      if (!options.signal?.aborted && translator.resultError === undefined
        && exitCode !== undefined && exitCode !== null && exitCode !== 0) {
        throw new Error(
          `CodeBuddy 进程异常退出(code ${exitCode}${exitSignal !== undefined ? `,signal ${exitSignal}` : ''})${stderrNote}`,
        )
      }
      // 流末:剩余文本**自己**落地到当前 step,不再 yield 给 agent-loop。
      // yield 过去的话,agent-loop 会把这条尾部总结 append 到它自己的初始
      // step,于是尾巴跑到会话开头。它最终 append 的那条 message 因此是空
      // 的——空内容不会覆盖已显示的 blocks(assistant-step 节点按 step 累
      // 积,追加空块等于不变),初始 step 也就只是一个不显示的空节点。
      // 注意顺序:必须先落地再闭合 step,否则流末文本会落到一个新开的、
      // 最后没人闭合的 step 里。
      flushText()
      // 收尾:闭合最后一个 step,避免它留在 open 状态被 UI 当成进行中。
      closeStep()
      pendingChunks = []
      for (const chunk of translator.end()) yield chunk
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
