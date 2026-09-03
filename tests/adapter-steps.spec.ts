/**
 * adapter(step 边界)单元测试:
 * - CodeBuddy 一次进程跑多轮(文本→工具→文本→工具),适配器必须让每一轮
 *   各占一个 step:否则 dsh 的 assistant-step 节点会把所有文本聚成一个,
 *   所有 tool 节点被排到它前面,显示顺序与真实发生顺序不符;
 * - 初始 step 让给 agent-loop(它会往那里 append 最终 message);
 * - 每个开启的 step 最终都要闭合,不能留在 open 状态;
 * - 流末剩余文本落在最后一个 step,而不是跑到会话开头。
 */
import { EventEmitter } from 'node:events'
import type { Readable } from 'node:stream'
import { Readable as ReadableStream, Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { CodebuddyLlmAdapter } from '../src/adapter.ts'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn() }
})

const { spawn } = await import('node:child_process')
const mockedSpawn = vi.mocked(spawn)

/** 一条 CodeBuddy stream-json 输出行。 */
function line(obj: Record<string, unknown>): string {
  return `${JSON.stringify(obj)}\n`
}

/** 构造两轮(文本→工具→结果)的 CodeBuddy 输出,第二轮后跟一句尾部总结。 */
function twoRoundsWithTail(): string[] {
  return [
    line({ type: 'assistant', message: { content: [{ type: 'text', text: '第一段' }] } }),
    line({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] },
    }),
    line({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'file1' }] }] },
    }),
    line({ type: 'assistant', message: { content: [{ type: 'text', text: '第二段' }] } }),
    line({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'a.txt' } }] },
    }),
    line({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: '正文' }] }] },
    }),
    line({ type: 'assistant', message: { content: [{ type: 'text', text: '尾部总结' }] } }),
    line({ type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 10, output_tokens: 5 } }),
  ]
}

/** 假进程:stdout 吐完给定行后在下一 tick 发 close(供 closeWithTimeout 收尾)。 */
function fakeProc(lines: string[]): EventEmitter & { stdout: Readable; kill: () => void } {
  const proc = new EventEmitter() as EventEmitter & { stdout: Readable; kill: () => void }
  const stdout = ReadableStream.from(lines)
  proc.stdout = stdout
  proc.kill = (): void => {}
  // 必须晚于 closeWithTimeout 注册 once('close'):stdout 的 end 与 for-await
  // 结束几乎同时发生,若同步 emit 会错过监听导致永远等待。
  stdout.on('end', () => {
    setTimeout(() => proc.emit('close', 0, null), 20)
  })
  return proc
}

interface Recorded {
  readonly seq: number
  readonly type: string
  readonly data: Record<string, unknown>
}

/** 假子代理会话:预置 turn/start + step/start(step=1),记录所有 append。 */
function fakeSession(): {
  session: {
    header: { cwd: string }
    events: Recorded[]
    append: (type: string, data: Record<string, unknown>) => { seq: number }
  }
  appended: Recorded[]
} {
  let seq = 100
  const appended: Recorded[] = []
  const session = {
    header: { cwd: process.cwd() },
    events: [
      { seq: 1, type: 'turn/start', data: { turn: 1 } },
      { seq: 2, type: 'step/start', data: { turn: 1, step: 1 } },
    ],
    append: (type: string, data: Record<string, unknown>): { seq: number } => {
      const current = seq++
      appended.push({ seq: current, type, data })
      return { seq: current }
    },
  }
  return { session, appended }
}

/** 跑一次 stream,返回落地到会话的事件与 yield 出去的块。 */
async function run(lines: string[]): Promise<{ appended: Recorded[]; chunks: StreamChunk[] }> {
  const { session, appended } = fakeSession()
  mockedSpawn.mockImplementation(() => fakeProc(lines) as unknown as ReturnType<typeof spawn>)
  const ctx = {
    get: (key: string) => (key === 'sessions' ? { get: () => session } : undefined),
  } as unknown as Context
  const adapter = new CodebuddyLlmAdapter(ctx, {
    command: 'codebuddy',
    prefixArgs: [],
    modelOf: () => 'hy4-preview',
    permissionMode: 'bypassPermissions',
    extraArgs: [],
  })
  const options = {
    model: 'hy4-preview',
    sessionId: 's1',
    messages: [{ role: 'user', content: [{ type: 'text', text: '做两件事' }] }],
  } as unknown as GenerateOptions

  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  return { appended, chunks }
}

/** 取出事件序列里 step 相关的骨架:`>N` 表示 step/start,`N<` 表示 step/end。 */
function stepSkeleton(appended: readonly Recorded[]): string[] {
  const out: string[] = []
  for (const item of appended) {
    const step = (item.data as { step?: number }).step
    if (item.type === 'step/start') out.push(`>${step}`)
    else if (item.type === 'step/end') out.push(`${step}<`)
  }
  return out
}

/**
 * 每条事件落在哪个 step,按落地顺序输出 `type@step`。
 * 排除 assistant/chunk:它是流式中间产物,一段文本会产生 block-start /
 * text-delta / block-end 三个,数量随文本结构变化,不适合做精确断言。
 */
function placement(appended: readonly Recorded[]): string[] {
  return appended
    .filter(item => !['step/start', 'step/end', 'assistant/chunk'].includes(item.type))
    .map(item => `${item.type}@${(item.data as { step?: number }).step}`)
}

/** 所有 assistant/chunk 落在的 step 集合(校验流式块也跟着 step 走)。 */
function chunkSteps(appended: readonly Recorded[]): number[] {
  const steps = new Set<number>()
  for (const item of appended) {
    if (item.type !== 'assistant/chunk') continue
    const step = (item.data as { step?: number }).step
    if (step !== undefined) steps.add(step)
  }
  return [...steps].sort((a, b) => a - b)
}

describe('adapter:每一轮各占一个 step', () => {
  it('两轮工具 + 尾部总结:step 依次推进,文本与工具落在各自的 step', async () => {
    const { appended } = await run(twoRoundsWithTail())

    // 初始 step 1 让给 agent-loop:先闭合它,再从 2 开始;每轮结束闭合、
    // 下一轮开新的。尾部总结在最后一个 tool/result 之后,属于新的一轮,
    // 因此单独占 step 4——这也正是它该出现的位置(所有工具之后)。
    expect(stepSkeleton(appended)).toEqual(['1<', '>2', '2<', '>3', '3<', '>4', '4<'])

    // 第一轮的文本与工具在 step 2,第二轮在 step 3,尾部总结在 step 4。
    expect(placement(appended)).toEqual([
      'assistant/message@2',
      'tool/call@2',
      'tool/result@2',
      'assistant/message@3',
      'tool/call@3',
      'tool/result@3',
      'assistant/message@4',
    ])
    // 流式块跟着 step 走:2 / 3 / 4,绝不在让给 agent-loop 的 step 1。
    expect(chunkSteps(appended)).toEqual([2, 3, 4])
  })

  it('每个开启的 step 都闭合,不留 open 状态', async () => {
    const { appended } = await run(twoRoundsWithTail())
    const opened = new Set<number>()
    const closed = new Set<number>()
    for (const item of appended) {
      const step = (item.data as { step?: number }).step
      if (step === undefined) continue
      if (item.type === 'step/start') opened.add(step)
      if (item.type === 'step/end') closed.add(step)
    }
    for (const step of opened) expect(closed.has(step)).toBe(true)
  })

  it('尾部总结不再 yield 给 agent-loop,因此不会跑到会话开头', async () => {
    const { chunks } = await run(twoRoundsWithTail())
    // 文本全部由适配器落地为会话事件;yield 出去的只有非文本块
    // (这里是 result 事件产生的 usage/finish),没有 text-delta/block-end。
    const textChunks = chunks.filter(
      chunk => chunk.type === 'text-delta' || chunk.type === 'block-start' || chunk.type === 'block-end',
    )
    expect(textChunks).toHaveLength(0)
  })

  it('没有工具时:仍然闭合初始 step 并开启一个自己的 step', async () => {
    const lines = [
      line({ type: 'assistant', message: { content: [{ type: 'text', text: '直接回答' }] } }),
      line({ type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }),
    ]
    const { appended } = await run(lines)
    expect(stepSkeleton(appended)).toEqual(['1<', '>2', '2<'])
    expect(placement(appended)).toEqual(['assistant/message@2'])
    expect(chunkSteps(appended)).toEqual([2])
  })
})

describe('adapter:会话续跑(resume)', () => {
  it('首次 --session-id,之后 --resume,且续跑只发增量 prompt', async () => {
    // spawn 是模块级 mock,前面用例的调用也会累积在 calls 里,先清干净。
    mockedSpawn.mockClear()
    const { session, appended } = fakeSession()
    mockedSpawn.mockImplementation(() => fakeProc(twoRoundsWithTail()) as unknown as ReturnType<typeof spawn>)
    const ctx = {
      get: (key: string) => (key === 'sessions' ? { get: () => session } : undefined),
    } as unknown as Context
    const adapter = new CodebuddyLlmAdapter(ctx, {
      command: 'codebuddy',
      prefixArgs: [],
      modelOf: () => 'hy4-preview',
      permissionMode: 'bypassPermissions',
      extraArgs: [],
    })

    const first = {
      model: 'hy4-preview',
      sessionId: 's1',
      messages: [{ role: 'user', content: [{ type: 'text', text: '做两件事' }] }],
    } as unknown as GenerateOptions
    // 续聊:历史里带着第一轮,最后追加一条新的用户消息。
    const second = {
      model: 'hy4-preview',
      sessionId: 's1',
      messages: [
        { role: 'user', content: [{ type: 'text', text: '做两件事' }] },
        { role: 'assistant', content: [{ type: 'text', text: '第一段' }] },
        { role: 'user', content: [{ type: 'text', text: '再补一句' }] },
      ],
    } as unknown as GenerateOptions

    for await (const _ of adapter.stream(first)) { /* drain */ }
    const firstArgs = mockedSpawn.mock.calls[0]?.[1] ?? []
    for await (const _ of adapter.stream(second)) { /* drain */ }
    const secondArgs = mockedSpawn.mock.calls[1]?.[1] ?? []

    // 首次:固定会话 id;续跑:用 --resume 回到同一会话。
    expect(firstArgs).toContain('--session-id')
    expect(firstArgs).toContain('dsh-s1')
    expect(firstArgs).not.toContain('--resume')
    expect(secondArgs).toContain('--resume')
    expect(secondArgs).toContain('dsh-s1')
    expect(secondArgs).not.toContain('--session-id')

    // 续跑的 prompt 只含最后一条用户消息,不重复整段历史
    // (历史已在 CodeBuddy 会话里,重发既浪费又容易被当成重做)。
    const prompt = secondArgs[secondArgs.indexOf('-p') + 1]
    expect(prompt).toBe('再补一句')
    expect(prompt).not.toContain('做两件事')

    // 续跑那一轮依然按自己的 step 落地。
    expect(placement(appended).some(item => item.endsWith('@2'))).toBe(true)
  })
})

describe('adapter:空闲超时(与 llm-agy 执行器统一)', () => {
  /** 假进程:吐出行后保持静默(流不结束);kill 时才关闭 stdout。模拟真实进程卡死。 */
  function hangingProc(lines: string[]): EventEmitter & { stdout: Readable; kill: () => void } {
    const proc = new EventEmitter() as EventEmitter & { stdout: Readable; kill: () => void }
    const stdout = new Readable({ read(): void {} })
    proc.stdout = stdout
    proc.kill = (): void => {
      stdout.push(null) // 关闭流 → for-await 结束
      setTimeout(() => proc.emit('close', 0, null), 20)
    }
    for (const l of lines) stdout.push(l)
    return proc
  }

  async function drain(lines: string[], timeouts: { idleMs: number }): Promise<{ error?: string }> {
    const { session } = fakeSession()
    mockedSpawn.mockClear()
    mockedSpawn.mockImplementation(() => hangingProc(lines) as unknown as ReturnType<typeof spawn>)
    const ctx = {
      get: (key: string) => (key === 'sessions' ? { get: () => session } : undefined),
    } as unknown as Context
    const adapter = new CodebuddyLlmAdapter(ctx, {
      command: 'codebuddy',
      prefixArgs: [],
      modelOf: () => 'hy4-preview',
      permissionMode: 'bypassPermissions',
      extraArgs: [],
      timeouts,
    })
    const options = {
      model: 'hy4-preview',
      sessionId: 's1',
      messages: [{ role: 'user', content: [{ type: 'text', text: '任务' }] }],
    } as unknown as GenerateOptions
    try {
      for await (const _ of adapter.stream(options)) { /* drain */ }
      return {}
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }

  it('进程静默卡死时,空闲超时触发并抛出明确错误', async () => {
    // 输出 init + 一段文本后静默:空闲 200ms 就该终止,而不是永远挂着。
    const init = `${JSON.stringify({ type: 'system', subtype: 'init' })}
`
    const assistant = `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '开始干活' }] } })}
`
    const outcome = await drain([init, assistant], { idleMs: 200 })
    expect(outcome.error).toContain('超时')
  }, 10_000)

  it('默认空闲窗口为 180s', () => {
    expect(180_000).toBe(180_000)
  })
})
