/**
 * adapter 写入模式测试:direct(调用方已打开 step)与 stream(辅助调用/无会话)。
 * 覆盖:主/子会话直写、零 step 事件、purpose 辅助调用纯 chunk、abort 挂起工具收尾、
 * max_tokens 映射。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { CodebuddyLlmAdapter } from '../src/adapter.ts'
 import { ConversationStore } from '../src/conversations.ts'
import { asSpawnResult, autoHandshake, fakeAcpProc, message, thought, toolCall, toolUpdate } from './fake-acp.ts'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn() }
})
const { spawn } = await import('node:child_process')
const mockedSpawn = vi.mocked(spawn)

interface SessionShape {
  hasSession?: boolean
  /** 会话 header(不带 parentSession/origin 即主代理会话)。 */
  header?: Record<string, unknown>
  /** 是否已有调用方打开的 step。 */
  openStep?: boolean
  /** 是否已有调用方打开的 turn(start 但未 end)。 */
  openTurn?: boolean
}

function makeAdapter(
  shape: SessionShape = {},
  timeouts?: Record<string, number>,
): {
  adapter: CodebuddyLlmAdapter
  appended: Array<{ type: string; data: unknown; opts?: unknown }>
  createdMetas: Array<Record<string, unknown> | undefined>
  shadowEvents: Array<{ type: string; data: unknown }>
  savedImages: Array<{ mediaType: string; bytes: number }>
} {
  const appended: Array<{ type: string; data: unknown; opts?: unknown }> = []
  const events: Array<{ type: string; data: Record<string, unknown> }> = []
  if (shape.openTurn !== false) events.push({ type: 'turn/start', data: { turn: 1 } })
  if (shape.openStep !== false) events.push({ type: 'step/start', data: { turn: 1, step: 1 } })
  const createdMetas: Array<Record<string, unknown> | undefined> = []
  const shadowEvents: Array<{ type: string; data: unknown }> = []
  const session = {
    header: shape.header ?? { cwd: process.cwd(), parentSession: 'p1', origin: 'subagent', delegationDepth: 1 },
    append: (type: string, data: unknown, opts?: unknown) => {
      appended.push({ type, data, opts })
      return { seq: appended.length }
    },
    ownEvents: () => events,
    // 影子子会话(子代理镜像)创建面。
    create: (_id?: unknown, options?: { meta?: Record<string, unknown> }) => {
      createdMetas.push(options?.meta)
      return {
        id: 'shadow-test',
        append: (type: string, data: unknown) => {
          shadowEvents.push({ type, data })
          return { seq: shadowEvents.length - 1 }
        },
      }
    },
  }
  const ctx = {
    get: (key: string) => (key === 'sessions' && shape.hasSession !== false ? { get: () => session, create: session.create } : undefined),
  } as unknown as Context
  const savedImages: Array<{ mediaType: string; bytes: number }> = []
  const ctxWithImages = ctx as unknown as { get: (key: string) => unknown }
  const originalGet = ctxWithImages.get.bind(ctxWithImages)
  ctxWithImages.get = (key: string) => key === 'attachments'
    ? { saveImage: async (input: { data: Uint8Array; mediaType: string }) => { savedImages.push({ mediaType: input.mediaType, bytes: input.data.byteLength }); return { attachmentId: 'sha256:test', mediaType: input.mediaType, bytes: input.data.byteLength, width: 1, height: 1 } } }
    : originalGet(key)
  const adapter = new CodebuddyLlmAdapter(ctx, {
    command: 'codebuddy.js',
    prefixArgs: [],
    modelOf: () => 'glm-5.3',
    permissionMode: 'bypassPermissions',
    extraArgs: [],
    store: new ConversationStore(null),
    ...(timeouts !== undefined ? { timeouts } : {}),
  })
  return { adapter, appended, createdMetas, shadowEvents, savedImages }
}

function makeOptions(
  sessionId: string | undefined,
  extra?: Partial<GenerateOptions>,
  signal?: AbortSignal,
): GenerateOptions {
  return {
    model: 'glm-5.3',
    provider: 'codebuddy',
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(signal !== undefined ? { signal } : {}),
    messages: [{ role: 'user', content: [{ type: 'text', text: '任务' }] }],
    ...extra,
  } as unknown as GenerateOptions
}

/** 跑一轮:thinking/文本/工具/收尾,返回 yield 出的 chunk JSON。 */
async function runTurn(
  adapter: CodebuddyLlmAdapter,
  options: GenerateOptions,
  script?: (p: ReturnType<typeof fakeAcpProc>) => void,
): Promise<string[]> {
  mockedSpawn.mockImplementation(() => {
    const p = fakeAcpProc()
    autoHandshake(p)
    setTimeout(() => {
      script?.(p)
    }, 5)
    return asSpawnResult(p)
  })
  const chunks: string[] = []
  for await (const chunk of adapter.stream(options)) chunks.push(JSON.stringify(chunk))
  return chunks
}

beforeEach(() => {
  mockedSpawn.mockReset()
})

describe('adapter 模式:direct(已打开 step)', () => {
  it('主代理会话:直写事件,零 step 事件,沿用调用方的 turn/step', async () => {
    const { adapter, appended } = makeAdapter({ header: { cwd: process.cwd() } })
    await runTurn(adapter, makeOptions('s1'), (p) => {
      p.update(thought('想'))
      p.update(message('答'))
      p.update(toolCall('call_1', 'Bash', { command: 'echo hi' }))
      p.update(toolUpdate('call_1', 'completed', 'hi'))
      p.update(message('完成'))
      p.respond(p.requestLog().length, { stopReason: 'end_turn' })
    })
    expect(appended.some(a => a.type.startsWith('step/'))).toBe(false)
    expect(appended.every(a => {
      const d = a.data as { turn?: number; step?: number }
      return d.turn === 1 && d.step === 1
    })).toBe(true)
    const adIndex = appended.findIndex(a =>
      a.type === 'assistant/message' && JSON.stringify(a.data).includes('"type":"tool-call"'))
    const callIndex = appended.findIndex(a => a.type === 'tool/call')
    expect(adIndex).toBeGreaterThanOrEqual(0)
    expect(adIndex).toBeLessThan(callIndex)
    expect(appended.some(a => a.type === 'tool/result')).toBe(true)
  }, 15_000)

  it('子代理会话(有 lineage)行为一致', async () => {
    const { adapter, appended } = makeAdapter()
    await runTurn(adapter, makeOptions('s1'), (p) => {
      p.update(message('输出'))
      p.respond(p.requestLog().length, { stopReason: 'end_turn' })
    })
    // 延写一块:单块轮次不落持久块(该块走循环收尾消息);无 step 事件(调用方自管)。
    expect(appended.filter(a => a.type === 'assistant/message').length).toBe(0)
    expect(appended.some(a => a.type.startsWith('step/'))).toBe(false)
  }, 15_000)
})

describe('adapter 模式:stream(辅助调用/无会话)', () => {
  it('purpose=compaction:零会话写入,吐 block-start/text-delta/block-end/finish', async () => {
    const { adapter, appended } = makeAdapter()
    const chunks = await runTurn(adapter, makeOptions('s1', { purpose: 'compaction' } as Partial<GenerateOptions>), (p) => {
      p.update(thought('构思'))
      p.update(message('摘要文本'))
      p.respond(p.requestLog().length, { stopReason: 'end_turn' })
    })
    expect(appended.length).toBe(0)
    expect(chunks.some(c => c.includes('"block-start"'))).toBe(true)
    expect(chunks.some(c => c.includes('"text-delta"') && c.includes('摘要文本'))).toBe(true)
    expect(chunks.some(c => c.includes('"block-end"'))).toBe(true)
    expect(chunks.some(c => c.includes('"stop"'))).toBe(true)
  }, 15_000)

  it('无打开 step:退化为纯 chunk 流,不写会话', async () => {
    const { adapter, appended } = makeAdapter({ openStep: false })
    const chunks = await runTurn(adapter, makeOptions('s1'), (p) => {
      p.update(message('文本'))
      p.respond(p.requestLog().length, { stopReason: 'end_turn' })
    })
    expect(appended.length).toBe(0)
    expect(chunks.some(c => c.includes('"text-delta"'))).toBe(true)
  }, 15_000)

  it('无会话:同样退化为纯 chunk 流', async () => {
    const { adapter, appended } = makeAdapter({ hasSession: false })
    const chunks = await runTurn(adapter, makeOptions(undefined), (p) => {
      p.update(message('文本'))
      p.respond(p.requestLog().length, { stopReason: 'end_turn' })
    })
    expect(appended.length).toBe(0)
    expect(chunks.some(c => c.includes('"text-delta"'))).toBe(true)
  }, 15_000)
})

describe('adapter 模式:abort 与 stopReason', () => {
  it('abort 时挂起工具收尾:补广告 + call + 错误 result', async () => {
    const controller = new AbortController()
    const { adapter, appended } = makeAdapter()
    mockedSpawn.mockImplementation(() => {
      const p = fakeAcpProc()
      autoHandshake(p)
      p.onRequest(msg => {
        if (msg.method === 'session/prompt') {
          const check = setInterval(() => {
            if (p.notifications().some(n => n.method === 'session/cancel')) {
              clearInterval(check)
              p.respond(msg.id, { stopReason: 'cancelled' })
            }
          }, 50)
        }
      })
      setTimeout(() => {
        p.update(toolCall('call_9', 'Bash', { command: 'sleep 999' }))
      }, 20)
      return asSpawnResult(p)
    })
    const streamPromise = (async (): Promise<void> => {
      for await (const _ of adapter.stream(makeOptions('s1', undefined, controller.signal))) { /* drain */ }
    })()
    setTimeout(() => controller.abort(), 300)
    await streamPromise
    expect(appended.some(a => a.type === 'tool/call')).toBe(true)
    const result = appended.find(a => a.type === 'tool/result')
    expect(result).toBeDefined()
    expect(JSON.stringify(result!.data)).toContain('ended before this tool reported completion')
    expect(JSON.stringify(result!.data)).toContain('"isError":true')
    expect(appended.some(a => a.type.startsWith('step/'))).toBe(false)
  }, 15_000)

  it('stopReason=max_tokens → finish max-tokens', async () => {
    const { adapter } = makeAdapter()
    const chunks = await runTurn(adapter, makeOptions('s1'), (p) => {
      p.update(message('被截断'))
      p.respond(p.requestLog().length, { stopReason: 'max_tokens' })
    })
    expect(chunks.some(c => c.includes('"max-tokens"'))).toBe(true)
  }, 15_000)

  it('reasoningEffort → spawn 参数带 --effort <level>;未选则不传', async () => {
    const { adapter } = makeAdapter()
    await runTurn(adapter, makeOptions('s1', { reasoningEffort: 'xhigh' } as Partial<GenerateOptions>), (p) => {
      p.update(message('答'))
      p.respond(p.requestLog().length, { stopReason: 'end_turn' })
    })
    const withEffort = (mockedSpawn.mock.calls.at(-1)?.[1] ?? []) as string[]
    expect(withEffort.join(' ')).toContain('--effort xhigh')

    mockedSpawn.mockReset()
    const second = makeAdapter()
    await runTurn(second.adapter, makeOptions('s1'), (p) => {
      p.update(message('答'))
      p.respond(p.requestLog().length, { stopReason: 'end_turn' })
    })
    const withoutEffort = (mockedSpawn.mock.calls.at(-1)?.[1] ?? []) as string[]
    expect(withoutEffort).not.toContain('--effort')
  }, 15_000)
})

describe('adapter:CodeBuddy 子代理镜像', () => {
  it('Agent 调用(isSubagent)→ 影子会话创建(带 lineage)+ 收尾', async () => {
    const { adapter, createdMetas, shadowEvents } = makeAdapter()
    await runTurn(adapter, makeOptions('s1'), (p) => {
      p.update({
        sessionUpdate: 'tool_call',
        toolCallId: 'call_ag',
        title: 'Agent',
        kind: 'other',
        status: 'pending',
        rawInput: { description: '调研任务', prompt: '看看 1+1 等于几' },
        _meta: { 'codebuddy.ai/toolName': 'Agent', 'codebuddy.ai/isSubagent': true, 'codebuddy.ai/toolArgumentsComplete': true },
      })
      p.update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_ag',
        status: 'completed',
        rawOutput: { type: 'text', text: '2\n\n[Agent ID: agent-it-1]' },
      })
      p.respond(p.requestLog().length, { stopReason: 'end_turn' })
    })
    expect(createdMetas.length).toBe(1)
    expect(createdMetas[0]).toMatchObject({ parentSession: 's1', origin: 'subagent' })
    const types = shadowEvents.map(e => e.type)
    expect(types[0]).toBe('subagent/descriptor')
    expect(JSON.stringify(shadowEvents[0]!.data)).toContain('调研任务')
    expect(types).toContain('turn/start')
    expect(types).toContain('step/start')
    expect(types.at(-2)).toBe('step/end')
    expect(types.at(-1)).toBe('turn/end')
  }, 15_000)

  it('普通工具调用不创建影子会话', async () => {
    const { adapter, createdMetas } = makeAdapter()
    await runTurn(adapter, makeOptions('s1'), (p) => {
      p.update(toolCall('call_1', 'Bash', { command: 'echo hi' }))
      p.update(toolUpdate('call_1', 'completed', 'hi'))
      p.respond(p.requestLog().length, { stopReason: 'end_turn' })
    })
    expect(createdMetas.length).toBe(0)
  }, 15_000)
})

describe('adapter:图片消息 → ACP 原生 image 内容块', () => {
  it('用户消息带图片时,session/prompt 发送 {type:image,data,mimeType} 块', async () => {
    const appended: Array<{ type: string; data: unknown }> = []
    const session = {
      header: { cwd: process.cwd(), parentSession: 'p1', origin: 'subagent' },
      append: (type: string, data: unknown) => { appended.push({ type, data }); return { seq: appended.length } },
      ownEvents: () => [
        { type: 'turn/start', data: { turn: 1 } },
        { type: 'step/start', data: { turn: 1, step: 1 } },
      ],
    }
    const ctx = {
      get: (key: string) => {
        if (key === 'sessions') return { get: () => session }
        if (key === 'attachments') {
          return { readImage: async () => ({ data: new Uint8Array([9, 8, 7]), ref: { mediaType: 'image/png' } }) }
        }
        return undefined
      },
    } as unknown as Context
    const adapter = new CodebuddyLlmAdapter(ctx, {
      command: 'codebuddy.js',
      prefixArgs: [],
      modelOf: () => 'glm-5.3',
      permissionMode: 'bypassPermissions',
      extraArgs: [],
      store: new ConversationStore(null),
    })
    const promptParams: Array<Record<string, unknown>> = []
    mockedSpawn.mockImplementation(() => {
      const p = fakeAcpProc()
      autoHandshake(p)
      p.onRequest(request => {
        if (request.method === 'session/prompt') {
          promptParams.push(request.params)
          setTimeout(() => p.respond(request.id, { stopReason: 'end_turn' }), 5)
        }
      })
      setTimeout(() => { p.update(message('ok')) }, 5)
      return asSpawnResult(p)
    })
    const options = makeOptions('s1', {
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: '看图' },
          { type: 'image', attachment: { attachmentId: 'img-1' } },
        ],
      }] as never,
    })
    for await (const _ of adapter.stream(options)) { /* drain */ }
    const blocks = promptParams[0]!['prompt'] as Array<Record<string, unknown>>
    expect(blocks[0]).toMatchObject({ type: 'text' })
    const image = blocks.find(block => block['type'] === 'image')
    expect(image).toBeDefined()
    expect(image!['mimeType']).toBe('image/png')
    expect(image!['data']).toBe(Buffer.from([9, 8, 7]).toString('base64'))
  }, 15_000)
})

describe('adapter:任务工具 → todo/write 桥接', () => {
  it('TaskCreate/结果/TaskUpdate → 整表快照事件(UI TodoPanel)', async () => {
    const { adapter, appended } = makeAdapter()
    await runTurn(adapter, makeOptions('s1'), (p) => {
      p.update({
        sessionUpdate: 'tool_call',
        toolCallId: 'call_t1',
        title: 'TaskCreate',
        status: 'pending',
        rawInput: { subject: '改造后端' },
        _meta: { 'codebuddy.ai/toolName': 'TaskCreate', 'codebuddy.ai/toolArgumentsComplete': true },
      })
      p.update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_t1',
        status: 'completed',
        rawOutput: { type: 'text', text: 'Task #1 created successfully: 改造后端' },
      })
      p.update({
        sessionUpdate: 'tool_call',
        toolCallId: 'call_t2',
        title: 'TaskUpdate',
        status: 'pending',
        rawInput: { taskId: '1', status: 'completed' },
        _meta: { 'codebuddy.ai/toolName': 'TaskUpdate', 'codebuddy.ai/toolArgumentsComplete': true },
      })
      p.update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_t2',
        status: 'completed',
        rawOutput: { type: 'text', text: 'Updated task #1 status' },
      })
      p.update(message('任务已更新'))
      p.respond(p.requestLog().length, { stopReason: 'end_turn' })
    })
    const todos = appended
      .filter(entry => entry.type === 'todo/write')
      .map(entry => (entry.data as { todos: unknown }).todos)
    // 仅"列表变化"写快照:创建 1 次 + 状态更新 1 次(结果绑定 id 不重复写)。
    expect(todos.length).toBeGreaterThanOrEqual(2)
    expect(todos[0]).toEqual([{ content: '改造后端', status: 'pending' }])
    expect(todos.at(-1)).toEqual([{ content: '改造后端', status: 'completed' }])
  }, 15_000)
})

describe('adapter:中途插入(steering)', () => {
  /** 建一个已打开 step 的直写会话(插入投递的前置条件)。 */
  function directSession(): { events: Array<{ type: string; data?: unknown }>; ctx: Context } {
    const events: Array<{ type: string; data?: unknown }> = [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'step/start', data: { turn: 1, step: 1 } },
    ]
    const session = {
      header: { cwd: process.cwd(), parentSession: 'p1', origin: 'subagent' },
      append: () => ({ seq: events.length }),
      ownEvents: () => events,
    }
    return { events, ctx: { get: (key: string) => (key === 'sessions' ? { get: () => session } : undefined) } as unknown as Context }
  }

  /** 生成中在指定队列插入一条用户消息(80ms 后,留出短轮询窗口)。 */
  function spliceAfter(events: Array<{ type: string; data?: unknown }>, target: 'next-step' | 'next-turn'): void {
    setTimeout(() => {
      events.push({
        type: 'agent/inbox/spliced',
        data: {
          target,
          start: 0,
          inserted: [{
            id: 'ins-1',
            role: 'user',
            content: [{ type: 'text', text: '插一句话:先别做别的' }],
            source: { kind: 'user' },
          }],
        },
      })
    }, 80)
  }

  it('插话(next-step)走 ACP session/steer 注入当前运行,不再排队 prompt;同 id 只发一次', async () => {
    const { events, ctx } = directSession()
    const adapter = new CodebuddyLlmAdapter(ctx, {
      command: 'codebuddy.js',
      prefixArgs: [],
      modelOf: () => 'glm-5.3',
      permissionMode: 'bypassPermissions',
      extraArgs: [],
      store: new ConversationStore(null),
      steerPollMs: 40,
    })
    const prompts: Array<Array<Record<string, unknown>>> = []
    const steers: Array<Record<string, unknown>> = []
    mockedSpawn.mockImplementation(() => {
      const p = fakeAcpProc()
      autoHandshake(p)
      p.onRequest(request => {
        if (request.method === 'session/steer') {
          steers.push(request.params)
          p.respond(request.id, { steered: true, ownerRequestId: 'req-1' })
          return
        }
        if (request.method !== 'session/prompt') return
        prompts.push(request.params['prompt'] as Array<Record<string, unknown>>)
        setTimeout(() => p.respond(request.id, { stopReason: 'end_turn' }), 500)
      })
      setTimeout(() => { p.update(message('处理中')) }, 10)
      return asSpawnResult(p)
    })
    spliceAfter(events, 'next-step')
    for await (const _ of adapter.stream(makeOptions('s1'))) { /* drain */ }
    expect(steers.length).toBe(1)
    expect(steers[0]).toMatchObject({ sessionId: 'cb-1', contentBlocks: [{ type: 'text', text: '插一句话:先别做别的' }] })
    // 插话不当排队 prompt 再发一遍。
    expect(prompts.length).toBe(1)
  }, 15_000)

  it('排队(next-turn)不在生成中转发:留给 dsh 回合收尾 claim,不发 prompt 也不发 steer', async () => {
    const { events, ctx } = directSession()
    const adapter = new CodebuddyLlmAdapter(ctx, {
      command: 'codebuddy.js',
      prefixArgs: [],
      modelOf: () => 'glm-5.3',
      permissionMode: 'bypassPermissions',
      extraArgs: [],
      store: new ConversationStore(null),
      steerPollMs: 40,
    })
    const prompts: Array<Array<Record<string, unknown>>> = []
    let steerRequests = 0
    mockedSpawn.mockImplementation(() => {
      const p = fakeAcpProc()
      autoHandshake(p)
      p.onRequest(request => {
        if (request.method === 'session/steer') { steerRequests += 1; p.respond(request.id, { steered: true }); return }
        if (request.method !== 'session/prompt') return
        prompts.push(request.params['prompt'] as Array<Record<string, unknown>>)
        setTimeout(() => p.respond(request.id, { stopReason: 'end_turn' }), 500)
      })
      setTimeout(() => { p.update(message('处理中')) }, 10)
      return asSpawnResult(p)
    })
    spliceAfter(events, 'next-turn')
    for await (const _ of adapter.stream(makeOptions('s1'))) { /* drain */ }
    expect(steerRequests).toBe(0)
    // 只有开场那一条 prompt;排队消息不在生成中转发(dsh 收尾时 claim 成下一轮)。
    expect(prompts.length).toBe(1)
    expect(JSON.stringify(prompts[0])).not.toContain('插一句话')
  }, 15_000)

  it('先入队(next-turn)、再点「立即发送」(升级为 next-step):steer 必须发出去(回归:同 id 被去重吞掉)', async () => {
    const { events, ctx } = directSession()
    const adapter = new CodebuddyLlmAdapter(ctx, {
      command: 'codebuddy.js',
      prefixArgs: [],
      modelOf: () => 'glm-5.3',
      permissionMode: 'bypassPermissions',
      extraArgs: [],
      store: new ConversationStore(null),
      steerPollMs: 40,
    })
    const prompts: Array<Array<Record<string, unknown>>> = []
    const steers: Array<Record<string, unknown>> = []
    mockedSpawn.mockImplementation(() => {
      const p = fakeAcpProc()
      autoHandshake(p)
      p.onRequest(request => {
        if (request.method === 'session/steer') {
          steers.push(request.params)
          p.respond(request.id, { steered: true, ownerRequestId: 'req-1' })
          return
        }
        if (request.method !== 'session/prompt') return
        prompts.push(request.params['prompt'] as Array<Record<string, unknown>>)
        setTimeout(() => p.respond(request.id, { stopReason: 'end_turn' }), 600)
      })
      setTimeout(() => { p.update(message('处理中')) }, 10)
      return asSpawnResult(p)
    })
    // 打字 → next-turn;5s 后(这里 200ms)点「立即发送」→ 同 id 挪到 next-step。
    spliceAfter(events, 'next-turn')
    setTimeout(() => {
      events.push({
        type: 'agent/inbox/spliced',
        data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] },
      })
      events.push({
        type: 'agent/inbox/spliced',
        data: {
          target: 'next-step',
          start: 0,
          inserted: [{
            id: 'ins-1',
            role: 'user',
            content: [{ type: 'text', text: '插一句话:先别做别的' }],
            source: { kind: 'user' },
          }],
        },
      })
    }, 200)
    for await (const _ of adapter.stream(makeOptions('s1'))) { /* drain */ }
    expect(steers.length).toBe(1)
    expect(steers[0]).toMatchObject({ sessionId: 'cb-1', contentBlocks: [{ type: 'text', text: '插一句话:先别做别的' }] })
    // 同一条消息不许再作为排队 prompt 投一次(重复投递)。
    expect(prompts.length).toBe(1)
  }, 15_000)

  it('session/steer 被拒(steered:false)→ 退回排队 prompt,消息不丢', async () => {
    const { events, ctx } = directSession()
    const adapter = new CodebuddyLlmAdapter(ctx, {
      command: 'codebuddy.js',
      prefixArgs: [],
      modelOf: () => 'glm-5.3',
      permissionMode: 'bypassPermissions',
      extraArgs: [],
      store: new ConversationStore(null),
      steerPollMs: 40,
    })
    const prompts: Array<Array<Record<string, unknown>>> = []
    mockedSpawn.mockImplementation(() => {
      const p = fakeAcpProc()
      autoHandshake(p)
      p.onRequest(request => {
        if (request.method === 'session/steer') { p.respond(request.id, { steered: false, reason: 'idle' }); return }
        if (request.method !== 'session/prompt') return
        prompts.push(request.params['prompt'] as Array<Record<string, unknown>>)
        setTimeout(() => p.respond(request.id, { stopReason: 'end_turn' }), prompts.length === 1 ? 500 : 30)
      })
      setTimeout(() => { p.update(message('处理中')) }, 10)
      return asSpawnResult(p)
    })
    spliceAfter(events, 'next-step')
    for await (const _ of adapter.stream(makeOptions('s1'))) { /* drain */ }
    expect(prompts.length).toBe(2)
    expect(JSON.stringify(prompts[1])).toContain('插一句话')
  }, 15_000)
})

describe('adapter:尾巴窗口(后台任务续跑)', () => {
  /** CLI 心跳:agent 阶段(尾巴窗口判据;真 CLI 在会话建立后就持续推)。 */
  const phase = (value: string): Record<string, unknown> => ({
    sessionUpdate: 'session_info_update',
    _meta: { 'codebuddy.ai/agentPhase': { phase: value } },
  })
  const sessionEnd = (): Record<string, unknown> => ({ sessionUpdate: 'session_end', stopReason: 'end_turn' })

  it('起了后台任务(run_in_background)→ 放宽静默阈值等续跑;续跑内容落进同一 step', async () => {
    const { adapter } = makeAdapter({}, { tailQuietMs: 80, tailBgQuietMs: 2_000, tailCapMs: 5_000 })
    const chunks = await runTurn(adapter, makeOptions('s1'), (p) => {
      p.update(phase('model_streaming'))   // CLI 心跳(尾巴窗口的能力探针)
      p.update(toolCall('call_bg', 'Bash', { command: 'npm test', run_in_background: true }))
      p.update(toolUpdate('call_bg', 'completed', 'Running in background with task_id: t1'))
      p.update(message('已后台启动,本轮先结束'))
      p.respond(p.requestLog().length, { stopReason: 'end_turn' })
      // 后台任务期间的长时间静默(远超 tailQuietMs):bg 阈值兜住,不许收尾。
      setTimeout(() => { p.update(message('后台回归完成:TAIL-CONTINUED')) }, 400)
      setTimeout(() => { p.update(sessionEnd()) }, 600)
    })
    const text = chunks.join('')
    expect(text).toContain('已后台启动')
    expect(text).toContain('后台回归完成:TAIL-CONTINUED')
  }, 15_000)

  it('后台任务迟迟没有续跑 → 撞 bg 静默阈值收尾,不等满硬顶', async () => {
    const { adapter } = makeAdapter({}, { tailQuietMs: 40, tailBgQuietMs: 250, tailCapMs: 30_000 })
    const started = Date.now()
    await runTurn(adapter, makeOptions('s1'), (p) => {
      p.update(phase('model_streaming'))
      p.update(toolCall('call_bg2', 'Bash', { command: 'npm run dev', run_in_background: true }))
      p.update(toolUpdate('call_bg2', 'completed', 'Running in background with task_id: t2'))
      p.update(message('服务已在后台起好'))
      p.respond(p.requestLog().length, { stopReason: 'end_turn' })
    })
    const elapsed = Date.now() - started
    expect(elapsed).toBeGreaterThanOrEqual(200)   // 等过 bg 阈值(没被普通阈值提前收掉)
    expect(elapsed).toBeLessThan(5_000)           // 也没拖到硬顶
  }, 15_000)

  it('CLI 空闲且静默超阈值 → 按时收尾,不等硬顶', async () => {
    const { adapter } = makeAdapter({}, { tailQuietMs: 100, tailCapMs: 60_000 })
    const started = Date.now()
    const chunks = await runTurn(adapter, makeOptions('s1'), (p) => {
      p.update(message('干完了'))
      p.update(phase('idle'))
      p.respond(p.requestLog().length, { stopReason: 'end_turn' })
    })
    expect(chunks.join('')).toContain('干完了')
    // 尾部只等一个静默阈值(100ms),远小于硬顶。
    expect(Date.now() - started).toBeLessThan(5_000)
  }, 15_000)

  it('老 CLI 无 agentPhase 心跳 → 不进尾巴窗口,收尾不额外延迟', async () => {
    const { adapter } = makeAdapter({}, { tailQuietMs: 5_000, tailCapMs: 60_000 })
    const started = Date.now()
    await runTurn(adapter, makeOptions('s1'), (p) => {
      p.update(message('普通一轮'))
      p.respond(p.requestLog().length, { stopReason: 'end_turn' })
    })
    expect(Date.now() - started).toBeLessThan(2_000)
  }, 15_000)

  it('cancel/abort 的回合不进尾巴窗口', async () => {
    const { adapter } = makeAdapter({}, { tailQuietMs: 5_000, tailCapMs: 60_000 })
    const controller = new AbortController()
    const started = Date.now()
    mockedSpawn.mockImplementation(() => {
      const p = fakeAcpProc()
      autoHandshake(p)
      p.onRequest(msg => {
        if (msg.method !== 'session/prompt') return
        const check = setInterval(() => {
          if (p.notifications().some(n => n.method === 'session/cancel')) {
            clearInterval(check)
            p.respond(msg.id, { stopReason: 'cancelled' })
          }
        }, 50)
      })
      setTimeout(() => { p.update(message('半途')) }, 20)
      // 心跳已见(资格本该成立)——但取消的回合必须直接收尾。
      setTimeout(() => { p.update(phase('model_streaming')) }, 30)
      return asSpawnResult(p)
    })
    const streamPromise = (async (): Promise<void> => {
      for await (const _ of adapter.stream(makeOptions('s1', undefined, controller.signal))) { /* drain */ }
    })()
    setTimeout(() => controller.abort(), 150)
    await streamPromise
    expect(Date.now() - started).toBeLessThan(3_000)
  }, 15_000)
})

describe('adapter:辅助调用(purpose)隔离', () => {
  it('purpose 调用不读映射(走 session/new,不 session/load)、不写映射、不建原生种子', async () => {
    const { mkdtempSync, readdirSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const baseDir = mkdtempSync(join(tmpdir(), 'cb-purpose-'))
    try {
      const store = new ConversationStore(null)
      const appended: Array<{ type: string; data: unknown }> = []
      const session = {
        header: { cwd: process.cwd(), parentSession: 'p1', origin: 'subagent' },
        append: (type: string, data: unknown) => { appended.push({ type, data }); return { seq: appended.length } },
        ownEvents: () => [
          { type: 'turn/start', data: { turn: 1 } },
          { type: 'step/start', data: { turn: 1, step: 1 } },
        ],
      }
      const ctx = { get: (key: string) => (key === 'sessions' ? { get: () => session } : undefined) } as unknown as Context
      const adapter = new CodebuddyLlmAdapter(ctx, {
        command: 'codebuddy.js',
        prefixArgs: [],
        modelOf: () => 'glm-5.3',
        permissionMode: 'bypassPermissions',
        extraArgs: [],
        store,
        nativeBaseDir: baseDir,
      })
      const newSessionParams: Array<Record<string, unknown>> = []
      mockedSpawn.mockImplementation(() => {
        const p = fakeAcpProc()
        autoHandshake(p)
        p.onRequest(request => {
          if (request.method === 'session/new') newSessionParams.push(request.params)
          if (request.method === 'session/prompt') setTimeout(() => p.respond(request.id, { stopReason: 'end_turn' }), 5)
        })
        setTimeout(() => { p.update(message('标题建议')) }, 5)
        return asSpawnResult(p)
      })
      // 复现竞态场景:purpose 调用率先发生且带多条消息——不能建会话种子、不能写映射。
      const options = makeOptions('s1', {
        purpose: 'session-title',
        messages: [
          { id: 'u1', role: 'user', content: [{ type: 'text', text: 'a' }], source: { kind: 'user' } },
          { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'b' }], source: { kind: 'model', provider: 'x', model: 'y' } },
          { id: 'u2', role: 'user', content: [{ type: 'text', text: 'c' }], source: { kind: 'user' } },
        ],
      } as never)
      for await (const _ of adapter.stream(options)) { /* drain */ }
      const log = (mockedSpawn.mock.results.at(-1)?.value as { requestLog?: () => string[] })?.requestLog?.() ?? []
      expect(log).toContain('session/new')
      expect(log).not.toContain('session/load')
      expect(store.get('s1')).toBeUndefined()
      expect(readdirSync(baseDir).length).toBe(0)
      // 隔离工作目录:旁路小会话不落进用户项目
      expect(String(newSessionParams[0]?.['cwd'])).toContain('codebuddy-duty')
    } finally {
      rmSync(baseDir, { recursive: true, force: true })
    }
  }, 15_000)
})

describe('adapter:看门狗(消费方被遗弃 + 工具永不返回)', () => {
  it('在途工具暂停空闲计时且消费方停止迭代时,看门狗按硬顶触发(cancel)', async () => {
    const { adapter } = makeAdapter({}, { idleMinMs: 300, idleMaxMs: 600, idleFactor: 1, idleWarmupLines: 0, firstMs: 5_000, guardCapMs: 500 })
    let killCount = 0
    let proc: ReturnType<typeof fakeAcpProc> | undefined
    mockedSpawn.mockImplementation(() => {
      const p = fakeAcpProc()
      proc = p
      autoHandshake(p)
      const original = p.kill.bind(p)
      p.kill = () => { killCount += 1; original() }
      // 在途工具(永不完成):armIdle 会清掉空闲计时并暂停——只剩看门狗兜底。
      setTimeout(() => { p.update(toolCall('call_stuck', 'Bash', { command: 'sleep 999' })) }, 10)
      return asSpawnResult(p)
    })
    const options = makeOptions('s1')
    const gen = adapter.stream(options)
    void gen.next() // 拉起(不等首个 chunk:本场景没有文本产出);之后不再迭代(模拟消费方被回收)
    while (proc === undefined) await new Promise(resolve => setTimeout(resolve, 50))
    // 看门狗(3s 一拍)应在硬顶(500ms)后触发:先 session/cancel,failStall 再 5s 强杀。
    await new Promise(resolve => setTimeout(resolve, 4_000))
    const cancelled = proc?.notifications().some(n => n.method === 'session/cancel') ?? false
    expect(cancelled).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 6_000))
    expect(killCount).toBeGreaterThanOrEqual(1) // 进程被强杀(不再泄漏)
    await gen.return?.(undefined)
  }, 15_000)
})

describe('adapter:看门狗(硬顶可关闭)', () => {
  it('guardCapMs=0 时不因静默长工具中止(永不误杀;接受泄漏风险)', async () => {
    const { adapter } = makeAdapter({}, { idleMinMs: 300, idleMaxMs: 600, idleFactor: 1, idleWarmupLines: 0, firstMs: 5_000, guardCapMs: 0 })
    let proc: ReturnType<typeof fakeAcpProc> | undefined
    mockedSpawn.mockImplementation(() => {
      const p = fakeAcpProc()
      proc = p
      autoHandshake(p)
      // 握手完成后才发工具调用(避免 capturing 窗口丢弃)。
      setTimeout(() => { p.update(toolCall('call_slow', 'Bash', { command: 'npm run long-suite' })) }, 300)
      return asSpawnResult(p)
    })
    const gen = adapter.stream(makeOptions('s1'))
    void gen.next()
    while (proc === undefined) await new Promise(resolve => setTimeout(resolve, 50))
    await new Promise(resolve => setTimeout(resolve, 7_000))
    const cancelled = proc?.notifications().some(n => n.method === 'session/cancel') ?? false
    expect(cancelled).toBe(false)
    // return 限时:生成器若卡在某个 await,测试也不能被拖死。
    await Promise.race([gen.return?.(undefined), new Promise(resolve => setTimeout(resolve, 2_000))])
  }, 15_000)
})

describe('adapter:工具结果图片', () => {
  it('图片文本 JSON → tool/result 转 image 块(与原生 read_image 同形状,base64 不进文本)', async () => {
    const { adapter, appended, savedImages } = makeAdapter()
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    const imageJson = JSON.stringify([{ type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } }])
    await runTurn(adapter, makeOptions('s1'), (p) => {
      p.update(toolCall('call_img', 'Read', { file_path: 'a.png' }))
      p.update(toolUpdate('call_img', 'completed', imageJson))
      p.respond(p.requestLog().length, { stopReason: 'end_turn' })
    })
    const result = appended.find(a => a.type === 'tool/result')
    expect(result).toBeDefined()
    const blocks = (result!.data as {
      message: { content: Array<{ content?: Array<Record<string, unknown>> }> }
    }).message.content[0]!.content ?? []
    expect(blocks.some(b => b['type'] === 'image')).toBe(true)
    expect(String(JSON.stringify(blocks).includes('data:image'))).toBe('false')
    expect(savedImages).toEqual([{ mediaType: 'image/png', bytes: Buffer.from(png, 'base64').byteLength }])
    // 图片路径的 Read 已改名为 read_image,且 result 带 meta.path(UI 图片卡渲染依据)。
    const call = appended.find(x => x.type === 'tool/call')!
    expect((call.data as { name: string }).name).toBe('read_image')
    expect((result!.data as { meta?: { path?: string } }).meta).toEqual({ path: 'a.png' })
    const ad = appended.find(x => x.type === 'assistant/message' && JSON.stringify(x.data).includes('read_image'))
    expect(ad).toBeDefined()
  }, 15_000)
})

describe('adapter:用量统计(底部统计栏)', () => {
  it('usage_update 逐条累计为本 step 合计:收尾 usage chunk = 总和;消息带 usage;工具广告带首 token 流', async () => {
    const { adapter, appended } = makeAdapter()
    const sampleOne = {
      prompt_tokens: 25414,
      completion_tokens: 24,
      total_tokens: 25438,
      prompt_cache_hit_tokens: 25216,
      prompt_cache_miss_tokens: 198,
    }
    const sampleTwo = {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      prompt_cache_hit_tokens: 0,
      prompt_cache_miss_tokens: 10,
    }
    const chunks = await runTurn(adapter, makeOptions('s1'), (p) => {
      p.update(message('正在处理'))
      p.update({ sessionUpdate: 'usage_update', used: 25414, size: 1_000_000, _meta: { usage: sampleOne } })
      p.update(toolCall('call_u1', 'Bash', { command: 'ls' }))
      p.update(toolUpdate('call_u1', 'completed', 'ok'))
      p.update({ sessionUpdate: 'usage_update', used: 10, size: 1_000_000, _meta: { usage: sampleTwo } })
      p.update(message('完成'))
      p.respond(p.requestLog().length, { stopReason: 'end_turn' })
    })
    // 收尾 usage chunk:两次请求求和的终值(循环收尾消息由此带上 usage)。
    const usageChunks = chunks.map(text => JSON.parse(text) as { type: string; usage?: Record<string, number> })
      .filter(chunk => chunk.type === 'usage')
    expect(usageChunks.length).toBe(1)
    expect(usageChunks[0]!.usage).toMatchObject({ inputTokens: 208, outputTokens: 29, cacheReadTokens: 25216 })
    // 工具广告(step 内第一条消息):带当时累计用量 + 首个增量(首 token 计时)。
    const messages = appended
      .filter(entry => entry.type === 'assistant/message')
      .map(entry => entry.data as {
        message: { content: Array<{ type: string }> }
        usage?: Record<string, number>
        stream: Array<{ chunk?: { type: string; text?: string }; time?: number }>
      })
    const ad = messages.find(item => item.message.content[0]?.type === 'tool-call')
    expect(ad).toBeDefined()
    expect(ad!.usage).toMatchObject({ inputTokens: 198, outputTokens: 24, cacheReadTokens: 25216 })
    expect(ad!.stream[0]?.chunk).toMatchObject({ type: 'text-delta', text: '正在处理' })
    expect(typeof ad!.stream[0]?.time).toBe('number')
    // 后写的文本块带累计终值。
    const piece = messages.find(item => item.message.content[0]?.type === 'text')
    expect(piece?.usage).toMatchObject({ inputTokens: 208, outputTokens: 29 })
  }, 15_000)
})

describe('adapter:压缩后续聊兜底(历史收缩)', () => {
  it('sentCount 超出当前消息数时,补发最后一条用户消息,而不是排在它后面的插件提醒', async () => {
    const store = new ConversationStore(null)
    store.set('s1', { acpId: 'cb-1', sentCount: 9999 })
    const session = {
      header: { cwd: process.cwd(), parentSession: 'p1', origin: 'subagent' },
      append: () => ({ seq: 1 }),
      ownEvents: () => [
        { type: 'turn/start', data: { turn: 1 } },
        { type: 'step/start', data: { turn: 1, step: 1 } },
      ],
    }
    const ctx = { get: (key: string) => (key === 'sessions' ? { get: () => session } : undefined) } as unknown as Context
    const adapter = new CodebuddyLlmAdapter(ctx, {
      command: 'codebuddy.js',
      prefixArgs: [],
      modelOf: () => 'glm-5.3',
      permissionMode: 'bypassPermissions',
      extraArgs: [],
      store,
    })
    const prompts: Array<Array<Record<string, unknown>>> = []
    mockedSpawn.mockImplementation(() => {
      const p = fakeAcpProc()
      autoHandshake(p)
      p.onRequest(request => {
        if (request.method !== 'session/prompt') return
        prompts.push(request.params['prompt'] as Array<Record<string, unknown>>)
        setTimeout(() => p.respond(request.id, { stopReason: 'end_turn' }), 5)
      })
      setTimeout(() => { p.update(message('好')) }, 5)
      return asSpawnResult(p)
    })
    const options = makeOptions('s1', {
      messages: [
        {
          id: 'm-summary',
          role: 'user',
          content: [{ type: 'text', text: 'This is an automatically generated checkpoint condensing…' }],
          source: { kind: 'plugin', plugin: 'compaction', form: 'snapshot' },
        },
        { id: 'u-new', role: 'user', content: [{ type: 'text', text: '账本设计还是过度设计' }], source: { kind: 'user' } },
        {
          id: 'ctx-1',
          role: 'user',
          content: [{ type: 'text', text: '<system-reminder>技能目录已更新</system-reminder>' }],
          source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-skill', form: 'snapshot' },
        },
      ] as never,
    })
    for await (const _ of adapter.stream(options)) { /* drain */ }
    const sent = JSON.stringify(prompts[0])
    expect(sent).toContain('账本设计还是过度设计')
    expect(sent).not.toContain('技能目录已更新')
  }, 15_000)
})
