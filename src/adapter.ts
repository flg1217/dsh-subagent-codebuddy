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
import { CallId, LlmAdapter, createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { buildPrompt } from './serialize.js'
import { CodebuddyTranslator } from './translate.js'

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
  constructor(
    private readonly ctx: Context,
    private readonly options: CodebuddyAdapterOptions,
  ) {
    super()
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const { command, prefixArgs, permissionMode } = this.options
    // 请求级 model 优先(子代理可经 agentOptions.model 动态指定),回退到当前默认模型。
    const model = options.model ?? this.options.modelOf()
    const { prompt, cleanup } = await buildPrompt(this.ctx, options)

    // 工作目录对齐子代理会话的工作区,保证文件操作发生在正确目录。
    const childSession = options.sessionId !== undefined ? this.ctx.get('sessions')?.get(options.sessionId) : undefined
    const cwd = childSession?.header.cwd ?? process.cwd()

    try {
      const proc: ChildProcess = spawn(command, [
        ...prefixArgs,
        '-p', prompt,
        '--output-format', 'stream-json',
        '--permission-mode', permissionMode,
        '--model', model,
        ...this.options.extraArgs,
      ], {
        cwd,
        stdio: ['ignore', 'pipe', 'inherit'],
        windowsHide: true,
      })
      if (proc.stdout === null) {
        proc.kill()
        throw new Error('subagent-codebuddy: codebuddy process has no stdout stream')
      }

      const onAbort = (): void => { proc.kill() }
      options.signal?.addEventListener('abort', onAbort, { once: true })

      // 工具步骤落地为会话事件所需的 turn/step(从子代理会话推断)。
      const session = options.sessionId !== undefined ? this.ctx.get('sessions')?.get(options.sessionId) : undefined
      const events = session?.events ?? []
      const turn = ([...events].reverse().find(e => e.type === 'turn/start')?.data.turn ?? 1) as number
      const step = ([...events].reverse().find(e => e.type === 'step/start')?.data.step ?? 1) as number
      const toolCallSeqs = new Map<string, number>()
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

      const translator = new CodebuddyTranslator()
      try {
        proc.stdout.setEncoding('utf8')
        const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity })
        for await (const line of rl) {
          if (options.signal?.aborted) {
            proc.kill()
            break
          }
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
              const ev = session.append('tool/call', {
                turn,
                step,
                callId: CallId(stepEvent.callId),
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
                  callId: CallId(stepEvent.callId),
                  content: [{ type: 'text', text: stepEvent.outputText ?? '' }],
                  isError: stepEvent.isError ?? false,
                }),
              }, {
                surfaceOp: 'append',
                ...(seq !== undefined ? { sourceEventSeqs: [seq] } : {}),
              })
            }
          }
        }
      } finally {
        options.signal?.removeEventListener('abort', onAbort)
      }

      await closeWithTimeout(proc, options.signal)
      // 流末:剩余文本 yield 给 agent-loop,使其最终 assistant/message 非空
      // (中间文本已在工具前 flush;无剩余文本时 agent-loop 消息为空,
      // 表示本流没有任何尾部总结,UI 显示已 flush 的中间消息)。
      for (const chunk of pendingChunks) yield chunk
      for (const chunk of translator.end()) yield chunk
    } finally {
      await cleanup()
    }
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
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
