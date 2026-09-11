/**
 * adapter 两条路径的测试(路线 C1):
 * 1. **回合泵**(会话绑定 + 调用方已打开 step = agent-loop 的对话轮):一个
 *    CodeBuddy 回合一个 ACP 进程,按模型调用切段;每个 dsh step 消费一段,
 *    工具调用注册 per-agent 的**回放工具**、由 loop 写原生事件——泵本身零
 *    会话写入(旧的直写/延写块/settle 摘队列机制已删除);
 * 2. **一次性旁路会话**(purpose 辅助调用 / 无会话调用):纯 chunk 流,零写入。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { CodebuddyLlmAdapter } from '../src/adapter.ts'
import { ConversationStore } from '../src/conversations.ts'
import { TurnPump, resetPumpStateForTests } from '../src/pump.ts'
import { asSpawnResult, autoHandshake, fakeAcpProc, lastFake, message, phase, sessionEnd, thought, toolCall, toolUpdate, usage } from './fake-acp.ts'
import type { FakeAcp } from './fake-acp.ts'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn() }
})
const { spawn } = await import('node:child_process')
const mockedSpawn = vi.mocked(spawn)

/** 测试用时序预算:把泵的各个阈值压到毫秒级。 */
const FAST = {
  firstMs: 2_000,
  idleMinMs: 5_000,
  idleMaxMs: 5_000,
  idleFactor: 2,
  idleWarmupLines: 6,
  tailQuietMs: 60,
  tailBgQuietMs: 240,
  tailCapMs: 800,
  boundaryQuietMs: 20,
  usageGraceMs: 20,
}

interface SessionShape {
  /** 假会话是否可查(缺省 true)。 */
  hasSession?: boolean
  /** 是否已有调用方打开的 step(缺省 true;false = 走一次性路径)。 */
  openStep?: boolean
  /** 会话 header(缺省:子代理会话)。 */
  header?: Record<string, unknown>
}

interface Harness {
  adapter: CodebuddyLlmAdapter
  /** 泵/适配器写进会话的事件(期望:泵路径恒为空)。 */
  appended: Array<{ type: string; data: unknown; opts?: unknown }>
  /** 会话自身事件(可追加 inbox splice 模拟插话)。 */
  events: Array<{ type: string; data?: unknown }>
  createdMetas: Array<Record<string, unknown> | undefined>
  shadowEvents: Array<{ type: string; data: unknown }>
  savedImages: Array<{ mediaType: string; bytes: number }>
  /** per-agent 注册的回放工具(name → 定义)。 */
  registeredTools: Map<string, Record<string, unknown>>
  promptParams: Array<Record<string, unknown>>
  spawns: () => number
}

function makeAdapter(shape: SessionShape = {}, timeouts?: Record<string, number>, store?: ConversationStore): Harness {
  const appended: Array<{ type: string; data: unknown; opts?: unknown }> = []
  const events: Array<{ type: string; data?: unknown }> = [
    { type: 'turn/start', data: { turn: 1 } },
    ...(shape.openStep === false ? [] : [{ type: 'step/start', data: { turn: 1, step: 1 } }]),
  ]
  const createdMetas: Array<Record<string, unknown> | undefined> = []
  const shadowEvents: Array<{ type: string; data: unknown }> = []
  const savedImages: Array<{ mediaType: string; bytes: number }> = []
  const registeredTools = new Map<string, Record<string, unknown>>()
  const promptParams: Array<Record<string, unknown>> = []
  const session = {
    header: shape.header ?? { cwd: process.cwd(), parentSession: 'p1', origin: 'subagent', delegationDepth: 1 },
    append: (type: string, data: unknown, opts?: unknown) => {
      appended.push({ type, data, opts })
      return { seq: appended.length }
    },
    ownEvents: () => events,
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
  const toolsFace = {
    register: (definition: Record<string, unknown>): (() => void) => {
      registeredTools.set(String(definition['name']), definition)
      return () => { registeredTools.delete(String(definition['name'])) }
    },
  }
  const agentFace = { ctx: { get: (key: string) => (key === 'tools' ? toolsFace : undefined) } }
  const ctx = {
    get: (key: string) => {
      if (key === 'sessions' && shape.hasSession !== false) return { get: () => session, create: session.create }
      if (key === 'agents') return { get: (id: string) => (id === 's1' ? agentFace : undefined) }
      if (key === 'attachments') {
        return {
          saveImage: async (input: { data: Uint8Array; mediaType: string }) => {
            savedImages.push({ mediaType: input.mediaType, bytes: input.data.byteLength })
            return { attachmentId: 'sha256:test', mediaType: input.mediaType, bytes: input.data.byteLength, width: 1, height: 1 }
          },
          readImage: async () => ({ data: new Uint8Array([9, 8, 7]), ref: { mediaType: 'image/png' } }),
        }
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
    store: store ?? new ConversationStore(null),
    steerPollMs: 20,
    ...(timeouts !== undefined ? { timeouts } : {}),
  })
  return {
    adapter, appended, events, createdMetas, shadowEvents, savedImages, registeredTools, promptParams,
    spawns: () => mockedSpawn.mock.results.length,
  }
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

/** 一个 step(agent-loop 的一次 provider 调用)的 chunk JSON。 */
async function step(adapter: CodebuddyLlmAdapter, options: GenerateOptions): Promise<string[]> {
  const chunks: string[] = []
  for await (const chunk of adapter.stream(options)) chunks.push(JSON.stringify(chunk))
  return chunks
}

interface TurnCtl {
  p: FakeAcp
  /** 结束当前在飞的 session/prompt(end_turn)。 */
  settle: (stopReason?: string) => void
}

/**
 * 假 ACP 进程 + 回合脚本(第 index 次 spawn 收到第 index 个脚本)。
 * @param setup - 在 spawn 同步阶段注册请求处理器(握手请求在脚本运行前就会到)。
 */
function mockTurn(
  script: (ctl: TurnCtl, index: number) => void,
  setup?: (ctl: TurnCtl) => void,
): void {
  let index = 0
  mockedSpawn.mockImplementation(() => {
    index += 1
    const p = fakeAcpProc()
    autoHandshake(p)
    const promptIds: number[] = []
    p.onRequest(request => {
      if (request.method === 'session/prompt') promptIds.push(request.id)
    })
    const ctl: TurnCtl = {
      p,
      settle: (stopReason = 'end_turn') => { for (const id of promptIds.splice(0)) p.respond(id, { stopReason }) },
    }
    setup?.(ctl)
    setTimeout(() => script(ctl, index), 5)
    return asSpawnResult(p)
  })
}

/** 生成中在指定队列插入一条用户消息。 */
function spliceAfter(events: Array<{ type: string; data?: unknown }>, target: 'next-step' | 'next-turn', delayMs = 60): void {
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
  }, delayMs)
}

beforeEach(() => {
  mockedSpawn.mockReset()
  resetPumpStateForTests()
})

describe('回合泵:一个 CodeBuddy 回合 = 多个原生 step', () => {
  it('工具边界把回合切成多段:每段一次 provider 调用,泵零会话写入', async () => {
    const h = makeAdapter({ header: { cwd: process.cwd() } }, FAST)
    mockTurn((c) => {
      c.p.update(thought('想'))
      c.p.update(message('先跑个命令'))
      c.p.update(toolCall('call_1', 'Bash', { command: 'echo hi' }))
      c.p.update(phase('tool_executing'))
      c.p.update(usage({ prompt_tokens: 120, completion_tokens: 8, prompt_cache_hit_tokens: 60 }))
      c.p.update(toolUpdate('call_1', 'completed', 'Command: echo hi\nStdout: hi'))
      setTimeout(() => {
        c.p.update(message('完成'))
        c.settle()
      }, 60)
    })
    const first = await step(h.adapter, makeOptions('s1'))
    expect(first.some(c => c.includes('先跑个命令'))).toBe(true)
    expect(first.some(c => c.includes('"type":"tool-call"') && c.includes('call_1'))).toBe(true)
    expect(first.some(c => c.includes('"type":"usage"'))).toBe(true)
    expect(first.some(c => c.includes('"stop"'))).toBe(true)
    // 泵不写任何会话事件:step/assistant/tool 全部由 agent-loop 原生写。
    expect(h.appended.length).toBe(0)
    // 回放工具按归一化名注册(per-agent),结果来自 ACP。
    expect(h.registeredTools.has('bash')).toBe(true)
    const tool = h.registeredTools.get('bash')!
    const value = await (tool['execute'] as (args: unknown, exec: unknown) => Promise<unknown>)({}, { callId: 'call_1' })
    expect(JSON.stringify(value)).toContain('Stdout: hi')

    const second = await step(h.adapter, makeOptions('s1'))
    expect(second.some(c => c.includes('完成'))).toBe(true)
    expect(second.some(c => c.includes('"stop"'))).toBe(true)
    // 第二段不再带第一段的用量(每段归自己的样本)。
    expect(second.some(c => c.includes('"type":"usage"') && c.includes('"inputTokens":120'))).toBe(false)
    expect(h.appended.length).toBe(0)
  }, 15_000)

  it('段内块有序:文本块在前、工具块在后;每段用量取自该次模型调用', async () => {
    const h = makeAdapter({}, FAST)
    mockTurn((c) => {
      c.p.update(message('甲'))
      c.p.update(toolCall('call_1', 'TodoWrite', { todos: [] }))
      c.p.update(phase('tool_executing'))
      c.p.update(usage({ prompt_tokens: 10, completion_tokens: 1 }))
      c.p.update(toolUpdate('call_1', 'completed', 'ok'))
      setTimeout(() => {
        c.p.update(message('乙'))
        c.p.update(usage({ prompt_tokens: 20, completion_tokens: 2 }))
        c.settle()
      }, 60)
    })
    const first = await step(h.adapter, makeOptions('s1'))
    const textEnd = first.findIndex(c => c.includes('"block-end"') && c.includes('甲'))
    const toolEnd = first.findIndex(c => c.includes('"block-end"') && c.includes('"tool-call"'))
    expect(textEnd).toBeGreaterThanOrEqual(0)
    expect(toolEnd).toBeGreaterThan(textEnd)
    expect(first.some(c => c.includes('"usage"') && c.includes('"inputTokens":10'))).toBe(true)

    const second = await step(h.adapter, makeOptions('s1'))
    expect(second.some(c => c.includes('乙'))).toBe(true)
    expect(second.some(c => c.includes('"usage"') && c.includes('"inputTokens":20'))).toBe(true)
  }, 15_000)

  it('stopReason=max_tokens → 最后一段 finish max-tokens', async () => {
    const h = makeAdapter({}, FAST)
    mockTurn((c) => {
      c.p.update(message('被截断'))
      c.settle('max_tokens')
    })
    const chunks = await step(h.adapter, makeOptions('s1'))
    expect(chunks.some(c => c.includes('"max-tokens"'))).toBe(true)
  }, 15_000)

  it('子代理会话(有 lineage)行为一致', async () => {
    const h = makeAdapter({}, FAST)
    mockTurn((c) => { c.p.update(message('输出')); c.settle() })
    const chunks = await step(h.adapter, makeOptions('s1'))
    expect(chunks.some(c => c.includes('输出'))).toBe(true)
    expect(chunks.some(c => c.includes('"stop"'))).toBe(true)
    expect(h.appended.length).toBe(0)
  }, 15_000)

  it('首段静默失败(零产出)→ 重启一次后正常收尾', async () => {
    const h = makeAdapter({}, { ...FAST, maxAttempts: 2, retryDelayMs: 20 })
    mockTurn((c, index) => {
      if (index === 1) { c.settle(); return } // 第一次:end_turn 但零产出
      c.p.update(message('恢复了'))
      c.settle()
    })
    const chunks = await step(h.adapter, makeOptions('s1'))
    expect(chunks.some(c => c.includes('恢复了'))).toBe(true)
    expect(h.spawns()).toBe(2)
  }, 15_000)

  it('CLI 进程中途退出 → 抛错给调用方(已有产出则不再重启)', async () => {
    const h = makeAdapter({}, { ...FAST, maxAttempts: 2, retryDelayMs: 20 })
    mockTurn((c) => {
      c.p.update(message('半句话'))
      setTimeout(() => c.p.close(1), 40)
    })
    await expect(step(h.adapter, makeOptions('s1'))).rejects.toThrow(/退出/)
    expect(h.spawns()).toBe(1)
  }, 15_000)

  it('看门狗硬顶:在途工具永不返回 → 硬顶到点 cancel,回放工具被拒', async () => {
    const h = makeAdapter({}, { ...FAST, guardCapMs: 60, maxAttempts: 1 })
    mockTurn((c) => {
      c.p.update(toolCall('call_1', 'Bash', { command: 'hang' }))
      c.p.update(phase('tool_executing'))
      // 工具永不返回:段在工具边界收尾(step 正常结束),但结果永不到——
      // 硬顶(guardCapMs)到点后泵失败、回放工具拒绝,下一步 attach 抛错。
    })
    const first = await step(h.adapter, makeOptions('s1'))
    expect(first.some(c => c.includes('"stop"'))).toBe(true)
    const waiting = (h.registeredTools.get('bash')!['execute'] as (args: unknown, exec: unknown) => Promise<unknown>)(
      {}, { callId: 'call_1' },
    )
    waiting.catch(() => { /* 断言在下面 */ })
    await expect(step(h.adapter, makeOptions('s1'))).rejects.toThrow(/超时/)
    await expect(waiting).rejects.toThrow()
    expect(lastFake()!.notifications().some(n => n.method === 'session/cancel')).toBe(true)
  }, 15_000)

  it('abort 中途:attach 返回且无 finish;cancel 通知发出;回放工具等待被拒', async () => {
    const controller = new AbortController()
    const h = makeAdapter({}, FAST)
    mockTurn((c) => {
      c.p.update(toolCall('call_1', 'Bash', { command: 'sleep 100' }))
      c.p.update(phase('tool_executing'))
      // 工具永不返回:边界由 phase 触发(cancel 由 abort 触发)。
    })
    const options = makeOptions('s1', {}, controller.signal)
    const first = await step(h.adapter, options)
    expect(first.some(c => c.includes('"stop"'))).toBe(true)
    expect(h.registeredTools.has('bash')).toBe(true)
    const pending = (h.registeredTools.get('bash')!['execute'] as (args: unknown, exec: unknown) => Promise<unknown>)(
      {}, { callId: 'call_1', signal: new AbortController().signal },
    )
    pending.catch(() => { /* 断言在下面 */ })
    controller.abort()
    // abort 后新的 attach 立即返回,不产生任何 chunk(loop 走中断语义);
    // 泵随之释放(未决的回放工具被拒,不悬挂)。
    const after = await step(h.adapter, options)
    expect(after.length).toBe(0)
    await expect(pending).rejects.toThrow()
    expect(lastFake()!.notifications().some(n => n.method === 'session/cancel')).toBe(true)
  }, 15_000)
})

describe('回放工具:结果与别名', () => {
  it('图片 Read → read_image 别名 + 结果转 image 块(带 meta.path)', async () => {
    const h = makeAdapter({}, FAST)
    const imageOutput = JSON.stringify([{ type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } }])
    mockTurn((c) => {
      c.p.update(toolCall('call_img', 'Read', { file_path: 'C:\\tmp\\shot.png' }))
      c.p.update(phase('tool_executing'))
      c.p.update(toolUpdate('call_img', 'completed', imageOutput))
      setTimeout(() => { c.p.update(message('看到了')); c.settle() }, 60)
    })
    const first = await step(h.adapter, makeOptions('s1'))
    expect(first.some(c => c.includes('read_image'))).toBe(true)
    expect(h.registeredTools.has('read_image')).toBe(true)
    const value = await (h.registeredTools.get('read_image')!['execute'] as (args: unknown, exec: unknown) => Promise<unknown>)(
      {}, { callId: 'call_img' },
    ) as { blocks: Array<Record<string, unknown>>; meta?: { path?: string } }
    expect(value.blocks.some(block => block['type'] === 'image')).toBe(true)
    expect(value.meta?.path).toBe('C:\\tmp\\shot.png')
    expect(h.savedImages.length).toBe(1)
  }, 15_000)

  it('工具失败(failed)→ 回放工具以错误收尾', async () => {
    const h = makeAdapter({}, FAST)
    mockTurn((c) => {
      c.p.update(toolCall('call_1', 'Bash', { command: 'false' }))
      c.p.update(phase('tool_executing'))
      c.p.update(toolUpdate('call_1', 'failed', 'exit code 1'))
      setTimeout(() => { c.p.update(message('失败了')); c.settle() }, 60)
    })
    await step(h.adapter, makeOptions('s1'))
    const tool = h.registeredTools.get('bash')!
    await expect((tool['execute'] as (args: unknown, exec: unknown) => Promise<unknown>)({}, { callId: 'call_1' }))
      .rejects.toThrow(/exit code 1/)
  }, 15_000)

  it('CodeBuddy 子代理调用(isSubagent)→ 影子会话创建(带 lineage)+ 收尾', async () => {
    const h = makeAdapter({}, FAST)
    mockTurn((c) => {
      c.p.update({
        sessionUpdate: 'tool_call',
        toolCallId: 'call_ag',
        title: 'Agent',
        kind: 'other',
        status: 'pending',
        rawInput: { description: '调研任务', prompt: '看看 1+1 等于几' },
        _meta: { 'codebuddy.ai/toolName': 'Agent', 'codebuddy.ai/isSubagent': true, 'codebuddy.ai/toolArgumentsComplete': true },
      })
      c.p.update(phase('tool_executing'))
      c.p.update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_ag',
        status: 'completed',
        rawOutput: { type: 'text', text: '2\n\n[Agent ID: agent-it-1]' },
      })
      setTimeout(() => { c.p.update(message('子代理完成')); c.settle() }, 60)
    })
    await step(h.adapter, makeOptions('s1'))
    expect(h.createdMetas.length).toBe(1)
    expect(h.createdMetas[0]).toMatchObject({ parentSession: 's1', origin: 'subagent' })
    const types = h.shadowEvents.map(e => e.type)
    expect(types[0]).toBe('subagent/descriptor')
    expect(JSON.stringify(h.shadowEvents[0]!.data)).toContain('调研任务')
    expect(types.at(-1)).toBe('turn/end')
  }, 15_000)
})

describe('任务工具 → todo/write 桥接(泵内)', () => {
  it('TaskCreate/结果/TaskUpdate → 整表快照事件(UI TodoPanel)', async () => {
    const h = makeAdapter({}, FAST)
    mockTurn((c) => {
      c.p.update({
        sessionUpdate: 'tool_call',
        toolCallId: 'call_t1',
        title: 'TaskCreate',
        status: 'pending',
        rawInput: { subject: '改造后端' },
        _meta: { 'codebuddy.ai/toolName': 'TaskCreate', 'codebuddy.ai/toolArgumentsComplete': true },
      })
      c.p.update(phase('tool_executing'))
      c.p.update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_t1',
        status: 'completed',
        rawOutput: { type: 'text', text: 'Task #1 created successfully: 改造后端' },
      })
      setTimeout(() => {
        c.p.update({
          sessionUpdate: 'tool_call',
          toolCallId: 'call_t2',
          title: 'TaskUpdate',
          status: 'pending',
          rawInput: { taskId: '1', status: 'completed' },
          _meta: { 'codebuddy.ai/toolName': 'TaskUpdate', 'codebuddy.ai/toolArgumentsComplete': true },
        })
        c.p.update(phase('tool_executing'))
        c.p.update({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call_t2',
          status: 'completed',
          rawOutput: { type: 'text', text: 'Updated task #1 status' },
        })
        setTimeout(() => { c.p.update(message('任务已更新')); c.settle() }, 60)
      }, 60)
    })
    await step(h.adapter, makeOptions('s1'))
    await step(h.adapter, makeOptions('s1'))
    await step(h.adapter, makeOptions('s1'))
    const todos = h.appended
      .filter(entry => entry.type === 'todo/write')
      .map(entry => (entry.data as { todos: unknown }).todos)
    expect(todos.length).toBeGreaterThanOrEqual(2)
    expect(todos[0]).toEqual([{ content: '改造后端', status: 'pending' }])
    expect(todos.at(-1)).toEqual([{ content: '改造后端', status: 'completed' }])
  }, 15_000)

  it('跨回合重播:会话日志里已有常驻任务表 → 新一轮开头重写一遍', async () => {
    const h = makeAdapter({}, FAST)
    h.events.push({
      type: 'todo/write',
      data: { todos: [{ content: '常驻任务', status: 'pending' }] },
    })
    mockTurn((c) => { c.p.update(message('新回合')); c.settle() })
    await step(h.adapter, makeOptions('s1'))
    const todos = h.appended
      .filter(entry => entry.type === 'todo/write')
      .map(entry => (entry.data as { todos: unknown }).todos)
    expect(todos[0]).toEqual([{ content: '常驻任务', status: 'pending' }])
  }, 15_000)
})

describe('中途插入(steering)', () => {
  it('插话(next-step)走 ACP session/steer 注入当前运行;同 id 只发一次', async () => {
    const h = makeAdapter({}, FAST)
    const steers: Array<Record<string, unknown>> = []
    const prompts: Array<unknown> = []
    let index = 0
    mockedSpawn.mockImplementation(() => {
      index += 1
      const p = fakeAcpProc()
      autoHandshake(p)
      const promptIds: number[] = []
      p.onRequest(request => {
        if (request.method === 'session/steer') {
          steers.push(request.params)
          p.respond(request.id, { steered: true, ownerRequestId: 'req-1' })
          return
        }
        if (request.method !== 'session/prompt') return
        promptIds.push(request.id)
        prompts.push(request.params['prompt'])
      })
      setTimeout(() => { p.update(message('处理中')) }, 5)
      setTimeout(() => { for (const id of promptIds.splice(0)) p.respond(id, { stopReason: 'end_turn' }) }, 300)
      return asSpawnResult(p)
    })
    spliceAfter(h.events, 'next-step')
    await step(h.adapter, makeOptions('s1'))
    expect(steers.length).toBe(1)
    expect(steers[0]).toMatchObject({ sessionId: 'cb-1', contentBlocks: [{ type: 'text', text: '插一句话:先别做别的' }] })
    // 插话不再作为排队 prompt 补发。
    expect(prompts.length).toBe(1)
  }, 15_000)

  it('排队(next-turn)不在生成中转发:不发 steer', async () => {
    const h = makeAdapter({}, FAST)
    let steerRequests = 0
    mockTurn((c) => {
      c.p.onRequest(request => {
        if (request.method === 'session/steer') { steerRequests += 1; c.p.respond(request.id, { steered: true }) }
      })
      c.p.update(message('处理中'))
      setTimeout(() => c.settle(), 300)
    })
    spliceAfter(h.events, 'next-turn')
    await step(h.adapter, makeOptions('s1'))
    expect(steerRequests).toBe(0)
  }, 15_000)

  it('先入队(next-turn)、再升级为 next-step:steer 必须发出去(回归)', async () => {
    const h = makeAdapter({}, FAST)
    const steers: Array<Record<string, unknown>> = []
    mockTurn((c) => {
      c.p.onRequest(request => {
        if (request.method === 'session/steer') {
          steers.push(request.params)
          c.p.respond(request.id, { steered: true })
        }
      })
      c.p.update(message('处理中'))
      setTimeout(() => c.settle(), 400)
    })
    // 先 next-turn,随后"立即发送"把它挪到 next-step(同 id)。
    setTimeout(() => {
      h.events.push({
        type: 'agent/inbox/spliced',
        data: {
          target: 'next-turn', start: 0,
          inserted: [{ id: 'ins-up', role: 'user', content: [{ type: 'text', text: '升级插话' }], source: { kind: 'user' } }],
        },
      })
      setTimeout(() => {
        h.events.push({ type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 1 } })
        h.events.push({
          type: 'agent/inbox/spliced',
          data: {
            target: 'next-step', start: 0,
            inserted: [{ id: 'ins-up', role: 'user', content: [{ type: 'text', text: '升级插话' }], source: { kind: 'user' } }],
          },
        })
      }, 80)
    }, 60)
    await step(h.adapter, makeOptions('s1'))
    expect(steers.length).toBe(1)
  }, 15_000)

  it('session/steer 被拒(steered:false)→ 退回排队 prompt,消息不丢', async () => {
    const h = makeAdapter({}, FAST)
    const prompts: Array<unknown> = []
    mockTurn(
      (c) => { c.p.update(message('处理中')); setTimeout(() => c.settle(), 400) },
      (c) => {
        c.p.onRequest(request => {
          if (request.method === 'session/steer') { c.p.respond(request.id, { steered: false, reason: 'idle' }); return }
          if (request.method === 'session/prompt') prompts.push(request.params['prompt'])
        })
      },
    )
    spliceAfter(h.events, 'next-step')
    await step(h.adapter, makeOptions('s1'))
    expect(prompts.length).toBe(2)
    expect(JSON.stringify(prompts[1])).toContain('插一句话')
  }, 15_000)
})

describe('尾巴窗口(后台任务续跑)', () => {
  it('起了后台任务 → 放宽静默阈值,续跑内容仍进同一段', async () => {
    const h = makeAdapter({}, { ...FAST, tailQuietMs: 40, tailBgQuietMs: 400 })
    mockTurn((c) => {
      c.p.update(toolCall('call_1', 'Bash', { command: 'npm run dev', run_in_background: true }))
      c.p.update(phase('tool_executing'))
      c.p.update(toolUpdate('call_1', 'completed', 'running in background'))
      setTimeout(() => {
        c.p.update(message('最终答复'))
        c.p.update(phase('idle'))
        // 后台任务完成后的自发续跑(普通阈值之后、bg 阈值之前)。
        setTimeout(() => c.p.update(message('续跑内容')), 150)
        c.settle()
      }, 60)
    })
    const first = await step(h.adapter, makeOptions('s1'))
    expect(first.some(c => c.includes('最终答复'))).toBe(false) // 第一段只有工具调用
    const second = await step(h.adapter, makeOptions('s1'))
    expect(second.some(c => c.includes('最终答复'))).toBe(true)
    expect(second.some(c => c.includes('续跑内容'))).toBe(true)
  }, 15_000)

  it('session_end 广播 → 立即收尾', async () => {
    const h = makeAdapter({}, { ...FAST, tailQuietMs: 5_000, tailBgQuietMs: 5_000 })
    mockTurn((c) => {
      c.p.update(phase('idle'))
      c.p.update(message('答'))
      c.p.update(sessionEnd())
      c.settle()
    })
    const started = Date.now()
    const chunks = await step(h.adapter, makeOptions('s1'))
    expect(chunks.some(c => c.includes('答'))).toBe(true)
    expect(Date.now() - started).toBeLessThan(2_000)
  }, 15_000)

  it('老 CLI 无 agentPhase 心跳 → 不进尾巴窗口,收尾不额外延迟', async () => {
    const h = makeAdapter({}, { ...FAST, tailQuietMs: 5_000, tailBgQuietMs: 5_000 })
    mockTurn((c) => { c.p.update(message('答')); c.settle() })
    const started = Date.now()
    const chunks = await step(h.adapter, makeOptions('s1'))
    expect(chunks.some(c => c.includes('答'))).toBe(true)
    expect(Date.now() - started).toBeLessThan(2_000)
  }, 15_000)
})

describe('adapter 模式:stream(一次性旁路会话)', () => {
  it('purpose=compaction:零会话写入,吐 block-start/text-delta/block-end/finish', async () => {
    const h = makeAdapter()
    mockTurn((c) => {
      c.p.update(thought('构思'))
      c.p.update(message('摘要文本'))
      c.settle()
    })
    const chunks = await step(h.adapter, makeOptions('s1', { purpose: 'compaction' } as Partial<GenerateOptions>))
    expect(h.appended.length).toBe(0)
    expect(chunks.some(c => c.includes('"block-start"'))).toBe(true)
    expect(chunks.some(c => c.includes('"text-delta"') && c.includes('摘要文本'))).toBe(true)
    expect(chunks.some(c => c.includes('"block-end"'))).toBe(true)
    expect(chunks.some(c => c.includes('"stop"'))).toBe(true)
  }, 15_000)

  it('无打开 step:退化为纯 chunk 流,不写会话', async () => {
    const h = makeAdapter({ openStep: false })
    mockTurn((c) => { c.p.update(message('文本')); c.settle() })
    const chunks = await step(h.adapter, makeOptions('s1'))
    expect(h.appended.length).toBe(0)
    expect(chunks.some(c => c.includes('"text-delta"'))).toBe(true)
  }, 15_000)

  it('无会话:同样退化为纯 chunk 流', async () => {
    const h = makeAdapter({ hasSession: false })
    mockTurn((c) => { c.p.update(message('文本')); c.settle() })
    const chunks = await step(h.adapter, makeOptions(undefined))
    expect(h.appended.length).toBe(0)
    expect(chunks.some(c => c.includes('"text-delta"'))).toBe(true)
  }, 15_000)

  it('reasoningEffort → spawn 参数带 --effort <level>;未选则不传', async () => {
    const h = makeAdapter({ openStep: false })
    mockTurn((c) => { c.p.update(message('答')); c.settle() })
    await step(h.adapter, makeOptions('s1', { reasoningEffort: 'high' } as Partial<GenerateOptions>))
    const argv = (mockedSpawn.mock.calls.at(-1)![1] ?? []).join(' ')
    expect(argv).toContain('--effort high')

    mockTurn((c) => { c.p.update(message('答')); c.settle() })
    await step(h.adapter, makeOptions('s1'))
    const argv2 = (mockedSpawn.mock.calls.at(-1)![1] ?? []).join(' ')
    expect(argv2).not.toContain('--effort')
  }, 15_000)
})

describe('adapter:step 输入只有已插话投递的消息', () => {
  it('已插话投递的消息在回合边界被 claim → 空跑收尾(不启动 CLI)', async () => {
    // 上一轮已把 ins-1 投递(标记 forwarded);本 step 的输入只有它 → 空跑。
    const store = new ConversationStore(null)
    store.set('s1', { acpId: 'cb-1', sentCount: 1 })
    const h = makeAdapter({}, FAST, store)
    const insertion = {
      id: 'ins-1',
      role: 'user',
      content: [{ type: 'text', text: '插一句话:先别做别的' }],
      source: { kind: 'user' },
    } as unknown as GenerateOptions['messages'][number]
    // 走一轮把 ins-1 标记为已转发(steer 送达)。
    mockTurn((c) => {
      c.p.onRequest(request => {
        if (request.method === 'session/steer') c.p.respond(request.id, { steered: true })
      })
      c.p.update(message('处理中'))
      setTimeout(() => c.settle(), 200)
    })
    spliceAfter(h.events, 'next-step', 20)
    await step(h.adapter, makeOptions('s1'))
    const spawnsBefore = h.spawns()
    const chunks = await step(h.adapter, makeOptions('s1', {
      messages: [
        { role: 'user', content: [{ type: 'text', text: '任务' }] },
        insertion,
      ] as GenerateOptions['messages'],
    }))
    expect(chunks.some(c => c.includes('"stop"'))).toBe(true)
    expect(chunks.some(c => c.includes('CONTINUE'))).toBe(false)
    expect(h.spawns()).toBe(spawnsBefore) // 不启动 CLI
  }, 15_000)
})

describe('回放工具的等待面', () => {
  it('结果未到时 execute 等待;回合收尾后拒绝(不悬挂)', async () => {
    const h = makeAdapter({}, { ...FAST, tailQuietMs: 40 })
    mockTurn((c) => {
      c.p.update(toolCall('call_1', 'Bash', { command: 'slow' }))
      c.p.update(phase('tool_executing'))
      // 工具结果永不来;回合随后干净收尾(空收尾段)。
      setTimeout(() => c.settle(), 120)
    })
    await step(h.adapter, makeOptions('s1'))
    const tool = h.registeredTools.get('bash')!
    let settled = false
    const waiting = (tool['execute'] as (args: unknown, exec: unknown) => Promise<unknown>)({}, { callId: 'call_1' })
    waiting.then(() => { settled = true }, () => { settled = true })
    await new Promise<void>(resolve => setTimeout(resolve, 30))
    expect(settled).toBe(false) // 仍在等待 ACP 结果
    await vi.waitFor(() => { expect(TurnPump.forSession('s1')).toBeUndefined() }, { timeout: 3_000 })
    await expect(waiting).rejects.toThrow()
  }, 15_000)
})
