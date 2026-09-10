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
  const adapter = new CodebuddyLlmAdapter(ctx, {
    command: 'codebuddy.js',
    prefixArgs: [],
    modelOf: () => 'glm-5.3',
    permissionMode: 'bypassPermissions',
    extraArgs: [],
    store: new ConversationStore(null),
    ...(timeouts !== undefined ? { timeouts } : {}),
  })
  return { adapter, appended, createdMetas, shadowEvents }
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
  it('生成中出现的 inbox 插入 → 作为排队 prompt 转发(同 id 只转一次)', async () => {
    const events: Array<{ type: string; data?: unknown }> = [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'step/start', data: { turn: 1, step: 1 } },
    ]
    const session = {
      header: { cwd: process.cwd(), parentSession: 'p1', origin: 'subagent' },
      append: () => ({ seq: events.length }),
      ownEvents: () => events,
    }
    const ctx = { get: (key: string) => (key === 'sessions' ? { get: () => session } : undefined) } as unknown as Context
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
        if (request.method !== 'session/prompt') return
        prompts.push(request.params['prompt'] as Array<Record<string, unknown>>)
        // 第一条延迟响应,留出中途插入窗口;第二条快速响应收尾。
        setTimeout(() => p.respond(request.id, { stopReason: 'end_turn' }), prompts.length === 1 ? 500 : 30)
        if (prompts.length === 1) {
          setTimeout(() => {
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
          }, 80)
        }
      })
      setTimeout(() => { p.update(message('处理中')) }, 10)
      return asSpawnResult(p)
    })
    for await (const _ of adapter.stream(makeOptions('s1'))) { /* drain */ }
    // 只转发一条(重复轮询同 id 不重发)。
    expect(prompts.length).toBe(2)
    expect(JSON.stringify(prompts[1])).toContain('插一句话')
    expect(prompts[1]![0]).toMatchObject({ type: 'text' })
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
