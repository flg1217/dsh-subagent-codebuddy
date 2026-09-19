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
  idleWrapMs: 60,
  boundaryQuietMs: 20,
  usageGraceMs: 20,
}

/** 本机跑得动的 shell 工具名(桥按平台剔除 bash,与 preset 的 `disabled:` 同规则)。 */
const NATIVE_SHELL = process.platform === 'win32' ? 'pwsh' : 'bash'

interface SessionShape {
  /** 假会话是否可查(缺省 true)。 */
  hasSession?: boolean
  /** 是否已有调用方打开的 step(缺省 true;false = 走一次性路径)。 */
  openStep?: boolean
  /** 会话 header(缺省:子代理会话)。 */
  header?: Record<string, unknown>
  /** 桥接模式透传(缺省不传 = 低层按 delegate)。 */
  bridgeMode?: 'mcp' | 'delegate'
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
  /** 触发一次 session/event(真工具直发的结果交付通道)。 */
  emitSessionEvent: (event: { type: string; data: unknown }) => void
}

function makeAdapter(
  shape: SessionShape = {},
  timeouts?: Record<string, number>,
  store?: ConversationStore,
  /** 回放工具注册面的注入口(注册失败重试的回归用)。 */
  toolsHooks?: { registerThrowsOnce?: boolean },
): Harness {
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
  /** 会话事件通道:pump 订阅 session/event(真工具直发的结果交付)。 */
  const sessionEventHandlers = new Set<(...args: unknown[]) => void>()
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
  let registerThrew = false
  const toolsFace = {
    register: (definition: Record<string, unknown>): (() => void) => {
      if (toolsHooks?.registerThrowsOnce === true && !registerThrew) {
        registerThrew = true
        throw new Error('agent scope not ready')
      }
      registeredTools.set(String(definition['name']), definition)
      return () => { registeredTools.delete(String(definition['name'])) }
    },
    // 注册表查询:ensureReplayTool 以此判重(不再用进程内 Set 记账)。
    schemas: () => [...registeredTools.keys()].map(name => ({ name })),
  }
  const agentFace = { ctx: { get: (key: string) => (key === 'tools' ? toolsFace : undefined) } }
  const ctx = {
    on: (name: string, handler: (...args: unknown[]) => void): (() => void) => {
      if (name !== 'session/event') return () => {}
      sessionEventHandlers.add(handler)
      return () => { sessionEventHandlers.delete(handler) }
    },
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
    ...(shape.bridgeMode === undefined ? {} : { bridgeMode: shape.bridgeMode }),
    ...(timeouts !== undefined ? { timeouts } : {}),
  })
  return {
    adapter, appended, events, createdMetas, shadowEvents, savedImages, registeredTools, promptParams,
    spawns: () => mockedSpawn.mock.results.length,
    emitSessionEvent: (event: { type: string; data: unknown }) => {
      const session = { header: { id: 's1' }, id: 's1' }
      for (const handler of [...sessionEventHandlers]) handler(session, event)
    },
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
    expect(h.registeredTools.has('cli_bash')).toBe(true)
    const tool = h.registeredTools.get('cli_bash')!
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

  it('CLI 进程中途退出 → finish error 交付调用方(已有产出则不再重启)', async () => {
    const h = makeAdapter({}, { ...FAST, maxAttempts: 2, retryDelayMs: 20 })
    mockTurn((c) => {
      c.p.update(message('半句话'))
      setTimeout(() => c.p.close(1), 40)
    })
    const chunks = await step(h.adapter, makeOptions('s1'))
    const finish = chunks.at(-1)!
    expect(finish).toContain('"kind":"error"')
    expect(finish).toContain('退出')
    expect(h.spawns()).toBe(1)
  }, 15_000)

  it('看门狗硬顶:在途工具永不返回 → 硬顶到点 cancel,回放工具被拒', async () => {
    const h = makeAdapter({}, { ...FAST, guardCapMs: 60, maxAttempts: 1 })
    mockTurn((c) => {
      c.p.update(toolCall('call_1', 'Bash', { command: 'hang' }))
      c.p.update(phase('tool_executing'))
      // 工具永不返回:段在工具边界收尾(step 正常结束),但结果永不到——
      // 硬顶(guardCapMs)到点后泵失败、回放工具拒绝,下一步以 finish error 收尾。
    })
    const first = await step(h.adapter, makeOptions('s1'))
    expect(first.some(c => c.includes('"stop"'))).toBe(true)
    const waiting = (h.registeredTools.get('cli_bash')!['execute'] as (args: unknown, exec: unknown) => Promise<unknown>)(
      {}, { callId: 'call_1' },
    )
    waiting.catch(() => { /* 断言在下面 */ })
    const second = await step(h.adapter, makeOptions('s1'))
    expect(second.at(-1)).toContain('"kind":"error"')
    expect(second.at(-1)).toContain('超时')
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
    expect(h.registeredTools.has('cli_bash')).toBe(true)
    const pending = (h.registeredTools.get('cli_bash')!['execute'] as (args: unknown, exec: unknown) => Promise<unknown>)(
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
  it('CLI 原生 Read(图片)→ cli_read 镜像 + 结果转 image 块', async () => {
    const h = makeAdapter({}, FAST)
    const imageOutput = JSON.stringify([{ type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } }])
    mockTurn((c) => {
      c.p.update(toolCall('call_img', 'Read', { file_path: 'C:\\tmp\\shot.png' }))
      c.p.update(phase('tool_executing'))
      c.p.update(toolUpdate('call_img', 'completed', imageOutput))
      setTimeout(() => { c.p.update(message('看到了')); c.settle() }, 60)
    })
    const first = await step(h.adapter, makeOptions('s1'))
    // 镜像名一律 `cli_` 前缀(裸名 `read_image` 会遮蔽 dsh 真工具,已删除)。
    expect(first.some(c => c.includes('cli_read'))).toBe(true)
    expect(h.registeredTools.has('cli_read')).toBe(true)
    const value = await (h.registeredTools.get('cli_read')!['execute'] as (args: unknown, exec: unknown) => Promise<unknown>)(
      {}, { callId: 'call_img' },
    ) as { blocks: Array<Record<string, unknown>> }
    // CLI 交付的图片 JSON 仍转成 dsh image 块(读图链路即使经原生工具也不丢图)。
    expect(value.blocks.some(block => block['type'] === 'image')).toBe(true)
    expect(h.savedImages.length).toBe(1)
  }, 15_000)

  it('回放工具注册失败 → 下次调用重试注册(不再一次失败即永久失效)', async () => {
    // 2026-09-18 修的 bug:注册前就记账 + 失败静默 → 该会话的原生工具调用
    // 永久报 `unknown tool "cli_read"`。现在以注册表为准,失败可自愈。
    const h = makeAdapter({}, FAST, undefined, { registerThrowsOnce: true })
    mockTurn((c) => {
      c.p.update(toolCall('call_a', 'Read', { file_path: 'a.ts' }))
      c.p.update(phase('tool_executing'))
      c.p.update(toolUpdate('call_a', 'completed', 'text-a'))
      // 第二次原生调用:注册表里仍没有 cli_read(第一次抛错未记账)→ 补注册。
      c.p.update(toolCall('call_b', 'Read', { file_path: 'b.ts' }))
      c.p.update(toolUpdate('call_b', 'completed', 'text-b'))
      c.settle()
    })
    await step(h.adapter, makeOptions('s1'))
    // 第一次注册抛错被吞(不记账),第二次调用补注册成功。
    expect(h.registeredTools.has('cli_read')).toBe(true)
  }, 15_000)

  it('空 DelegateTool 调用(无 toolId)→ 回放工具立即以错误收尾,不等 CLI 更新', async () => {
    const h = makeAdapter({}, FAST)
    mockTurn((c) => {
      // 模型偶发空参数 DelegateTool:CLI 本地会把调用改写成合法 JSON 继续,
      // 但不再回 completed 更新——本侧不能干等(实测挂 12 分钟)。
      c.p.update(toolCall('call_empty', 'DelegateTool', {}))
      c.p.update(phase('tool_executing'))
      setTimeout(() => { c.p.update(message('继续')); c.settle() }, 60)
    })
    await step(h.adapter, makeOptions('s1'))
    const tool = h.registeredTools.get('cli_delegate_tool')!
    await expect((tool['execute'] as (args: unknown, exec: unknown) => Promise<unknown>)({}, { callId: 'call_empty' }))
      .rejects.toThrow(/toolId/)
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
    const tool = h.registeredTools.get('cli_bash')!
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

  it('tail 期间 CLI 持续报空闲(idle 心跳)→ 短预算收尾,不等后台宽限', async () => {
    // 用户场景:会话跑完后 CLI 仍周期发 session_info 心跳;若心跳参与静默
    // 判定,回合要等满 tailBgQuietMs/tailCapMs 才收尾,UI 一直显示"进行中"。
    const h = makeAdapter({}, { ...FAST, tailQuietMs: 40, tailBgQuietMs: 60_000 })
    mockTurn((c) => {
      c.p.update(toolCall('call_1', 'Bash', { command: 'npm run dev', run_in_background: true }))
      c.p.update(phase('tool_executing'))
      c.p.update(toolUpdate('call_1', 'completed', 'running in background'))
      c.p.update(message('答复'))
      c.settle()
      // settle 之后 CLI 仍周期报空闲(心跳)。
      let ticks = 0
      const timer = setInterval(() => {
        ticks += 1
        if (ticks > 200) { clearInterval(timer); return }
        c.p.update(phase('idle'))
      }, 30)
    })
    const started = Date.now()
    const chunks = await step(h.adapter, makeOptions('s1'))
    expect(chunks.some(c => c.includes('答复'))).toBe(true)
    // 后台宽限 60s,但 idle 心跳把预算拉回 40ms。
    expect(Date.now() - started).toBeLessThan(5_000)
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

  it('prompt 结果挂起但 CLI 已报空闲+真实活动静默 → 强制收尾(不再无限等)', async () => {
    // 用户反复踩的场景:CLI 端回合已实际结束(内容推完、agentPhase=idle)但
    // session/prompt 的 RPC 结果不回(CLI 内部 turn 判定被后台任务/子代理挂
    // 住)。promptSettled=false 会短路尾巴窗口,看门狗又只咬在途镜像工具——
    // 此前 dsh 永远显示"进行中"。现在:真实活动静默超过空闲预算即强制收尾。
    const h = makeAdapter({}, { ...FAST, tailQuietMs: 40, idleWrapMs: 40, tailBgQuietMs: 60_000 })
    mockTurn((c) => {
      c.p.update(toolCall('call_1', 'Bash', { command: 'npm run dev', run_in_background: true }))
      c.p.update(phase('tool_executing'))
      c.p.update(toolUpdate('call_1', 'completed', 'running in background'))
      c.p.update(message('答复'))
      c.p.update(phase('idle'))
      // 故意不 settle:模拟 CLI 的 prompt 结果挂起。空闲心跳继续(CLI 空闲时
      // 会持续报 idle)——静默判定必须只看真实活动,不被心跳续命。
      let ticks = 0
      const timer = setInterval(() => {
        ticks += 1
        if (ticks > 400) { clearInterval(timer); return }
        c.p.update(phase('idle'))
      }, 30)
    })
    const started = Date.now()
    const chunks = await step(h.adapter, makeOptions('s1'))
    expect(chunks.some(c => c.includes('答复'))).toBe(true)
    // 后台宽限 60s、心跳不断,但真实活动静默 40ms 预算 → 秒级强制收尾。
    expect(Date.now() - started).toBeLessThan(5_000)
  }, 15_000)

  it('CLI 回合内的静默重试窗口(< idleWrapMs)→ 不强制收尾,重试内容进同一回合', async () => {
    // 实测回归(2026-09-14 16:55 session-cfb0b785):模型调了不存在的工具
    // (mcp__dsh__bash),CLI 判 ModelBehaviorError 结束本次 run,随后用
    // error-recovery 提示**重新请求模型**——重试期间 CLI 报过 idle 且内容静默,
    // 泵按 5s(tailQuietMs)强制收尾,把重试连同 CLI 进程一起杀了,对话在用户
    // 看来"莫名其妙就结束了"。idleWrapMs 必须比一次模型往返宽:窗口内只等待。
    const h = makeAdapter({}, { ...FAST, tailQuietMs: 40, idleWrapMs: 300, tailBgQuietMs: 60_000 })
    mockTurn((c) => {
      c.p.update(message('Let me read the ribbon subsystem.'))
      c.p.update(phase('idle'))
      // 错误 + 静默重试:200ms 内零内容(> tailQuietMs、< idleWrapMs)。
      setTimeout(() => {
        c.p.update(message('重试后的答复'))
        c.settle()
      }, 200)
    })
    const chunks = await step(h.adapter, makeOptions('s1'))
    // 若按 tailQuietMs 收尾:重试内容永远不来,断言失败。
    expect(chunks.some(c => c.includes('重试后的答复'))).toBe(true)
  }, 15_000)

  it('delegate shell 的 run_in_background 不算 CLI 后台任务 → 短预算收尾(不等 10 分钟)', async () => {
    // 用户反复踩的"跑完仍显示进行中":delegate 调用(dsh_<shell>)带
    // run_in_background:true 是 **dsh 侧 job**——立即返回、完成由 dsh 唤醒
    // 新回合,与 CLI 本回合收尾无关。此前它把尾巴预算拉到 tailBgQuietMs
    // (10 分钟),任务完成后 UI 一直转。
    const h = makeAdapter({}, { ...FAST, tailQuietMs: 40, tailBgQuietMs: 60_000 })
    mockTurn((c) => {
      c.p.update(toolCall('call_1', 'DelegateTool', { toolId: `dsh_${NATIVE_SHELL}`, input: { command: 'npm run dev', run_in_background: true } }))
      c.p.update(phase('tool_executing'))
      c.p.update(toolUpdate('call_1', 'completed', 'job started'))
      c.p.update(message('答复'))
      c.p.update(phase('idle'))
      c.settle()
    })
    const started = Date.now()
    const chunks = await step(h.adapter, makeOptions('s1'))
    expect(chunks.some(c => c.includes('答复'))).toBe(true)
    // 若误判为 CLI 后台任务:60s 预算,本断言必超时失败。
    expect(Date.now() - started).toBeLessThan(5_000)
  }, 15_000)

  it('重启后旧 attempt 的相位/尾巴状态已复位 → 新 attempt 不被提前收尾截断', async () => {
    // 旧实现:restart 不清 agentPhaseSeen/lastIdlePhaseAt/lastContentAt——
    // 新 attempt 发 prompt 期间,prompt-pending 强制收尾分支用**旧 attempt**
    // 的 idle 时间戳与归零的活动时间算出巨大静默,产出第一句后即被强制收尾,
    // 后续内容(第二句/真实结果)全部丢失。复位后必须完整收进。
    const h = makeAdapter({}, { ...FAST, maxAttempts: 2, retryDelayMs: 20, tailQuietMs: 5_000 })
    mockTurn((c, index) => {
      if (index === 1) {
        c.p.update(phase('idle'))
        c.settle() // 零产出 end_turn → 静默失败 → restart
        return
      }
      c.p.update(message('第一句'))
      setTimeout(() => { c.p.update(message('第二句')); c.settle() }, 150)
    })
    const chunks = await step(h.adapter, makeOptions('s1'))
    expect(h.spawns()).toBe(2)
    expect(chunks.some(c => c.includes('第一句'))).toBe(true)
    expect(chunks.some(c => c.includes('第二句'))).toBe(true)
  }, 15_000)
})

describe('真工具直发(delegate → dsh 原生工具/卡片)', () => {  it('delegate 调用以真工具名发射;CLI 请求经 tool/result 事件拿到结果', async () => {
    // 全量改造:delegate 调用不再走 cli_delegate_tool 镜像回放,而是翻译成
    // 真工具调用块(名字 edit),loop 直接执行 dsh 真工具——原生卡片/审批/
    // 沙箱/事件;结果由 loop 写 tool/result,泵从会话事件取回交给 CLI 请求。
    const h = makeAdapter({}, { ...FAST, maxAttempts: 1, tailQuietMs: 5_000 })
    let extResponse: { result?: unknown; error?: { message: string } } | undefined
    let settleFn: (() => void) | undefined
    mockTurn((c) => {
      settleFn = () => c.settle()
      c.p.update(toolCall('call_edit_1', 'DelegateTool', {
        toolId: 'dsh_edit',
        input: { file_path: 'a.ts', old_string: 'x', new_string: 'y' },
      }))
      c.p.update(phase('tool_executing'))
      void c.p.extRequest('_codebuddy.ai/delegateTool', {
        toolCallId: 'delegate-dsh_edit-1',
        toolId: 'dsh_edit',
        input: { file_path: 'a.ts', old_string: 'x', new_string: 'y' },
        timeout: 30_000,
      }).then(response => { extResponse = response })
    })
    const chunks = await step(h.adapter, makeOptions('s1'))
    // 块用真工具名 + 翻译后的参数(不再是 cli_delegate_tool 包裹)。
    expect(chunks.some(c => c.includes('"name":"edit"'))).toBe(true)
    expect(chunks.some(c => c.includes('cli_delegate_tool'))).toBe(false)
    expect(chunks.some(c => c.includes('old_string'))).toBe(true)
    // 不再为 delegate 调用注册回放工具(真工具已在 agent plane)。
    expect(h.registeredTools.has('cli_delegate_tool')).toBe(false)
    // loop 执行真工具后写 tool/result → 等待中的 CLI 请求拿到结果。
    h.emitSessionEvent({
      type: 'tool/result',
      data: {
        turn: 1,
        step: 1,
        message: {
          source: { kind: 'tool', callId: 'call_edit_1' },
          content: [{
            type: 'tool-result',
            toolCallId: 'call_edit_1',
            content: [{ type: 'text', text: '已编辑 a.ts' }],
          }],
        },
      },
    })
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(extResponse?.result).toEqual({ status: 'success', output: '已编辑 a.ts' })
    settleFn?.()
  }, 15_000)

  it('结果先到(请求未到)→ 缓存;请求到达时立即认领;失败结果转 status:error', async () => {
    const h = makeAdapter({}, { ...FAST, maxAttempts: 1, tailQuietMs: 5_000 })
    let extResponse: { result?: unknown; error?: { message: string } } | undefined
    let fakeProc: ReturnType<typeof lastFake>
    let settleFn: (() => void) | undefined
    mockTurn((c) => {
      fakeProc = c.p
      settleFn = () => c.settle()
      c.p.update(toolCall('call_bash_2', 'DelegateTool', {
        toolId: `dsh_${NATIVE_SHELL}`,
        input: { command: 'false' },
      }))
      c.p.update(phase('tool_executing'))
    })
    const chunks = await step(h.adapter, makeOptions('s1'))
    expect(chunks.some(c => c.includes(`"name":"${NATIVE_SHELL}"`))).toBe(true)
    // loop 很快执行完(结果先于 CLI 请求到达):事件先到 → 结果缓存。
    h.emitSessionEvent({
      type: 'tool/result',
      data: {
        turn: 1,
        step: 1,
        message: {
          source: { kind: 'tool', callId: 'call_bash_2' },
          content: [{
            type: 'tool-result',
            toolCallId: 'call_bash_2',
            content: [{ type: 'text', text: 'exit code 1' }],
            isError: true,
          }],
        },
      },
    })
    // 请求此刻才到 → 立刻拿缓存结果(失败 → status:error)。
    const pending = fakeProc!.extRequest('_codebuddy.ai/delegateTool', {
      toolCallId: 'delegate-shell-2',
      toolId: `dsh_${NATIVE_SHELL}`,
      input: { command: 'false' },
      timeout: 30_000,
    })
    void pending.then(response => { extResponse = response })
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(extResponse?.result).toEqual({ status: 'error', error: { message: 'exit code 1' } })
    settleFn?.()
  }, 15_000)

  it('回合中新注入的 user/message(已 claim 的通知)→ steer 投递给运行中的 CLI', async () => {
    // 回归:官方架构每 step 重组 messages(含新注入——UI 显示为"上下文注入");
    // codebuddy 回合中途注入曾无投递通道——子代理结算通知被 claim 后模型
    // 同回合内永远收不到,主代理一直"等待"。现在按注入水位线扫描并 steer。
    const h = makeAdapter({}, { ...FAST, maxAttempts: 1, tailQuietMs: 5_000 })
    let settleFn: (() => void) | undefined
    mockTurn((c) => {
      settleFn = () => c.settle()
      c.p.onRequest(msg => {
        if (msg.method === 'session/steer') c.p.respond(msg.id, { steered: true })
      })
      c.p.update(message('第一段'))
      c.p.update(toolCall('call_1', 'Bash', { command: 'echo hi' }))
      c.p.update(phase('tool_executing'))
      c.p.update(toolUpdate('call_1', 'completed', 'hi'))
      setTimeout(() => {
        c.p.update(message('第二段'))
        c.p.update(toolCall('call_2', 'Bash', { command: 'echo hi2' }))
        c.p.update(phase('tool_executing'))
        c.p.update(toolUpdate('call_2', 'completed', 'hi2'))
      }, 400)
    })
    const first = await step(h.adapter, makeOptions('s1'))
    expect(first.some(c => c.includes('第一段'))).toBe(true)
    // 回合运行中注入一条已 claim 的子代理结算通知(构造时间之后)。
    h.events.push({
      type: 'user/message',
      time: Date.now(),
      data: {
        id: 'note-1',
        role: 'user',
        content: [{ type: 'text', text: 'Background subagent abc finished and will do no further work.' }],
        source: { kind: 'subagent-settled' },
      },
    } as never)
    const second = await step(h.adapter, makeOptions('s1'))
    expect(second.some(c => c.includes('第二段'))).toBe(true)
    // 通知已通过 steer 投递(20ms 轮询窗口内),且只投一次(markForwarded 去重)。
    const steers = lastFake()!.requestLog().filter(m => m === 'session/steer')
    expect(steers.length).toBeGreaterThanOrEqual(1)
    settleFn?.()
  }, 15_000)

  it('同工具并发调用按参数精确配对(请求/结果乱序也不错配)', async () => {
    // 两个 delegate shell 调用并发:先到的是 bbb 的请求与 bbb 的结果——必须匹配到
    // call_b(参数精确),FIFO 会把 call_a 的结果错配给 bbb 的请求。
    const h = makeAdapter({}, { ...FAST, maxAttempts: 1, tailQuietMs: 5_000 })
    let settleFn: (() => void) | undefined
    let fakeProc: ReturnType<typeof lastFake>
    const responses: Array<{ result?: unknown }> = []
    mockTurn((c) => {
      fakeProc = c.p
      settleFn = () => c.settle()
      c.p.update(toolCall('call_a', 'DelegateTool', { toolId: `dsh_${NATIVE_SHELL}`, input: { command: 'aaa' } }))
      c.p.update(toolCall('call_b', 'DelegateTool', { toolId: `dsh_${NATIVE_SHELL}`, input: { command: 'bbb' } }))
      c.p.update(phase('tool_executing'))
    })
    const chunks = await step(h.adapter, makeOptions('s1'))
    expect(chunks.filter(c => c.includes(`"name":"${NATIVE_SHELL}"`)).length).toBe(2)
    // 乱序:b 的请求先到。
    const pendingB = fakeProc!.extRequest('_codebuddy.ai/delegateTool', {
      toolCallId: 'delegate-b',
      toolId: `dsh_${NATIVE_SHELL}`,
      input: { command: 'bbb' },
      timeout: 30_000,
    })
    void pendingB.then(response => { responses.push(response) })
    await new Promise(resolve => setTimeout(resolve, 30))
    // b 的结果也先到 → 精确配对交付给 b 的请求。
    h.emitSessionEvent({
      type: 'tool/result',
      data: {
        turn: 1,
        step: 1,
        message: {
          source: { kind: 'tool', callId: 'call_b' },
          content: [{ type: 'tool-result', toolCallId: 'call_b', content: [{ type: 'text', text: 'RESULT-B' }] }],
        },
      },
    })
    await new Promise(resolve => setTimeout(resolve, 60))
    expect((responses[0]?.result as { output?: string } | undefined)?.output).toBe('RESULT-B')
    settleFn?.()
  }, 15_000)

  it('steer 被拒(steered:false)→ 回退独立 prompt 补发,消息不丢', async () => {
    // 回归:fallback 路径此前零覆盖——steer 拒绝时必须回退 sendPrompt,
    // 且 prompt 请求层失败时要回滚 forwarded 标记(留给补发)。
    const h = makeAdapter({}, { ...FAST, maxAttempts: 1, tailQuietMs: 5_000 })
    let settleFn: (() => void) | undefined
    let fakeProc: ReturnType<typeof lastFake>
    let promptCount = 0
    mockTurn((c) => {
      fakeProc = c.p
      settleFn = () => c.settle()
      c.p.onRequest(msg => {
        if (msg.method === 'session/prompt') promptCount += 1
        if (msg.method === 'session/steer') c.p.respond(msg.id, { steered: false })
      })
      c.p.update(message('段一'))
      c.p.update(toolCall('call_1', 'Bash', { command: 'echo hi' }))
      c.p.update(phase('tool_executing'))
      c.p.update(toolUpdate('call_1', 'completed', 'hi'))
    })
    const first = await step(h.adapter, makeOptions('s1'))
    expect(first.some(c => c.includes('段一'))).toBe(true)
    const before = promptCount
    h.events.push({
      type: 'user/message',
      time: Date.now(),
      data: {
        id: 'note-fb',
        role: 'user',
        content: [{ type: 'text', text: 'Background subagent fb finished.' }],
        source: { kind: 'subagent-settled' },
      },
    } as never)
    // 等轮询:steer 被拒 → 回退 sendPrompt(计数增长)。
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(fakeProc!.requestLog().filter(m => m === 'session/steer').length).toBeGreaterThanOrEqual(1)
    expect(promptCount).toBeGreaterThan(before)
    settleFn?.()
  }, 15_000)

  it('同一条悬挂消息多轮轮询只投递一次(isForwarded 去重)', async () => {
    const h = makeAdapter({}, { ...FAST, maxAttempts: 1, tailQuietMs: 5_000 })
    let settleFn: (() => void) | undefined
    mockTurn((c) => {
      settleFn = () => c.settle()
      c.p.onRequest(msg => {
        if (msg.method === 'session/steer') c.p.respond(msg.id, { steered: true })
      })
      c.p.update(message('挂起段'))
      c.p.update(toolCall('call_1', 'Bash', { command: 'echo hi' }))
      c.p.update(phase('tool_executing'))
      c.p.update(toolUpdate('call_1', 'completed', 'hi'))
    })
    const first = await step(h.adapter, makeOptions('s1'))
    expect(first.some(c => c.includes('挂起段'))).toBe(true)
    // 悬挂插入(splice, 未 claim):每轮折叠都会返回它,但只应投递一次。
    h.events.push({
      type: 'agent/inbox/spliced',
      time: Date.now(),
      data: {
        target: 'next-step',
        start: 0,
        inserted: [{
          id: 'hang-1',
          role: 'user',
          content: [{ type: 'text', text: '悬挂插话' }],
          source: { kind: 'user' },
        }],
      },
    } as never)
    await new Promise(resolve => setTimeout(resolve, 300))
    const steers = lastFake()!.requestLog().filter(m => m === 'session/steer')
    expect(steers.length).toBe(1)
    settleFn?.()
  }, 15_000)

  it('dispatchMcpCall:调用块追加进段(无开放段则新开),结果经 tool/result 事件回填', async () => {
    // MCP → loop 转发:调用伪装成 tool-call 块追加进当前段,loop 顺序消费后
    // 原生执行;结果写 tool/result,泵按 callId 回填 dispatch 的 Promise。
    const h = makeAdapter({}, { ...FAST, maxAttempts: 1, tailQuietMs: 5_000 })
    let settleFn: (() => void) | undefined
    mockTurn((c) => {
      settleFn = () => c.settle()
      c.p.update(message('段一'))
      c.p.update(toolCall('call_1', 'Bash', { command: 'echo hi' }))
      c.p.update(phase('tool_executing'))
      c.p.update(toolUpdate('call_1', 'completed', 'hi'))
    })
    const first = await step(h.adapter, makeOptions('s1'))
    expect(first.some(c => c.includes('段一'))).toBe(true)
    const pump = TurnPump.forSession('s1')!
    const pending = pump.dispatchMcpCall('bash', { command: 'echo mcp' })
    // 调用块被下一次 step 消费:块名 = 真工具名,callId 带 mcp_ 前缀。
    const second = await step(h.adapter, makeOptions('s1'))
    const block = second.find(c => c.includes('"name":"bash"') && c.includes('mcp_'))
    expect(block).toBeDefined()
    const callId = (JSON.parse(block!) as { block: { id: string; arguments: string } }).block.id
    expect((JSON.parse(block!) as { block: { arguments: string } }).block.arguments).toBe('{"command":"echo mcp"}')
    // loop 执行完毕写 tool/result → 回填。
    h.emitSessionEvent({
      type: 'tool/result',
      data: {
        turn: 1,
        step: 2,
        message: {
          source: { kind: 'tool', callId },
          content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: 'mcp-executed' }] }],
        },
      },
    })
    await expect(pending).resolves.toEqual({
      output: 'mcp-executed',
      isError: false,
      content: [{ type: 'text', text: 'mcp-executed' }],
    })
    settleFn?.()
  }, 15_000)

  it('dispatchMcpCall 超时后结果迟到:经投递口补投(交互式工具答案不丢)', async () => {
    // 现场(2026-09-16):ask_user_question 等真人作答超过转发兜底窗口 → 分发拒绝、
    // CLI 收到超时错误并重问同一题;用户后来提交的答案没有通道可投,永久丢失
    // (用户侧表现:点提交,codebuddy 收不到回答)。修复:交互式工具用宽松窗口
    // (此处以 40ms 注入验证),且超时后记录 callId → 迟到投递口;tool/result
    // 稍后到达时经投递口把真实结果送回(端点负责补投进会话)。
    const h = makeAdapter({}, {
      ...FAST, maxAttempts: 1, tailQuietMs: 5_000, boundaryQuietMs: 5_000, interactiveMcpCallTimeoutMs: 40,
    })
    let settleFn: (() => void) | undefined
    mockTurn((c) => {
      settleFn = () => c.settle()
      c.p.update(message('段一'))
    })
    const firstP = step(h.adapter, makeOptions('s1'))
    await new Promise(resolve => setTimeout(resolve, 120))
    const pump = TurnPump.forSession('s1')!
    const late: Array<{ tool: string; text: string }> = []
    const pending = pump.dispatchMcpCall('ask_user_question', { questions: [] }, (tool, text) => {
      late.push({ tool, text })
    })
    // 超时:拒绝(McpDispatchTimeoutError),尚未补投。
    await expect(pending).rejects.toThrow(/ask_user_question/)
    expect(late).toEqual([])
    const first = await firstP
    const block = first.find(c => c.includes('"name":"ask_user_question"') && c.includes('mcp_'))
    expect(block).toBeDefined()
    const callId = (JSON.parse(block!) as { block: { id: string } }).block.id
    // 用户此刻才提交答案 → tool/result 迟到 → 投递口收到(工具名+答案文本)。
    h.emitSessionEvent({
      type: 'tool/result',
      data: {
        turn: 1,
        step: 2,
        message: {
          source: { kind: 'tool', callId },
          content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: '{"answers":[{"id":"q1","selected":["红色"]}]}' }] }],
        },
      },
    })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(late).toEqual([
      { tool: 'ask_user_question', text: '{"answers":[{"id":"q1","selected":["红色"]}]}' },
    ])
    settleFn?.()
  }, 15_000)

  it('dispatchMcpCall 竞态:调用先到(镜像事件未到)→ 真工具块并入当前开放段,同一 step 立即可见', async () => {
    // 回归(2026-09-13 现场):CLI 的 tools/call 与 ACP tool_call 事件先后不定。
    // 旧实现"先收尾无调用的段、另起独立注入段"在此形态下把段收成零调用 →
    // loop 判定"模型输出完成(无工具)"直接 turn/end,注入段永远无人消费
    // (子进程挂到 300s 超时回落直执),且最终答复因回合已关无法镜像、整条消失。
    // 现实现:调用块追加进当前开放段再随段收尾——本测试断言同一 step 内可见。
    const h = makeAdapter({}, { ...FAST, maxAttempts: 1, tailQuietMs: 5_000, boundaryQuietMs: 5_000 })
    let settleFn: (() => void) | undefined
    mockTurn((c) => {
      settleFn = () => c.settle()
      c.p.update(message('段一'))
      // 故意不发 tool_call 事件:模拟竞态里 dispatch 先到。
    })
    const firstP = step(h.adapter, makeOptions('s1'))
    // 等"段一"进入当前段;boundaryQuietMs 已放宽,段保持开放直至 dispatch 收尾。
    await new Promise(resolve => setTimeout(resolve, 120))
    const pump = TurnPump.forSession('s1')!
    const pending = pump.dispatchMcpCall('bash', { command: 'echo mcp' })
    const first = await firstP
    expect(first.some(c => c.includes('段一'))).toBe(true)
    const block = first.find(c => c.includes('"name":"bash"') && c.includes('mcp_'))
    expect(block).toBeDefined()
    const callId = (JSON.parse(block!) as { block: { id: string } }).block.id
    h.emitSessionEvent({
      type: 'tool/result',
      data: {
        turn: 1,
        step: 1,
        message: {
          source: { kind: 'tool', callId },
          content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: 'mcp-executed' }] }],
        },
      },
    })
    await expect(pending).resolves.toEqual({
      output: 'mcp-executed',
      isError: false,
      content: [{ type: 'text', text: 'mcp-executed' }],
    })
    settleFn?.()
  }, 15_000)

  it('dispatchMcpCall:回合收尾(pump 消失)后等待者被拒绝,不悬挂', async () => {
    // 覆盖 mcpWaiters 的 dispose 拒绝路径:CLI 在等一个永不到来的结果时,
    // 回合收尾必须让 dispatch 立即失败(端点据此回落或报错),不能永久悬挂。
    const h = makeAdapter({}, { ...FAST, maxAttempts: 1, tailQuietMs: 40 })
    let settleFn: (() => void) | undefined
    mockTurn((c) => {
      settleFn = () => c.settle()
      c.p.update(message('段一'))
    })
    const firstP = step(h.adapter, makeOptions('s1'))
    await new Promise(resolve => setTimeout(resolve, 100))
    const pump = TurnPump.forSession('s1')!
    const pending = pump.dispatchMcpCall('bash', { command: 'slow' })
    let settled = false
    pending.then(() => { settled = true }, () => { settled = true })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(settled).toBe(false) // 仍在等 loop 结果
    settleFn?.() // 干净收尾 → pump dispose
    await vi.waitFor(() => { expect(TurnPump.forSession('s1')).toBeUndefined() }, { timeout: 3_000 })
    await expect(pending).rejects.toThrow()
    await firstP.catch(() => { /* step 流已随收尾结束 */ })
  }, 15_000)

  it('mcp 模式:桥属调用不落镜像卡片;真实卡片由注入的原生调用呈现', async () => {
    // 真实卡片由 dispatchMcpCall 注入 loop 的原生调用呈现;镜像只会产生
    // cli_defer_execute_tool / cli_mcp__dsh__bash 套壳噪音,应静默(但登记
    // calls,防 tool_call_update 兜底路径重入 announceCall)。
    // 被抑制的调用不进 segment.calls,含它的段等注入到齐才收尾——真实链路一致。
    const h = makeAdapter({ bridgeMode: 'mcp' }, { ...FAST, maxAttempts: 1, tailQuietMs: 5_000 })
    let settleFn: (() => void) | undefined
    mockTurn((c) => {
      settleFn = () => c.settle()
      c.p.update(message('段一'))
      c.p.update(toolCall('call_d', 'DeferExecuteTool', { toolName: 'mcp__dsh__bash', params: { command: 'x' } }))
      c.p.update(toolCall('call_e', 'mcp__dsh__bash', { command: 'x' }))
      c.p.update(phase('tool_executing'))
      c.p.update(toolUpdate('call_d', 'completed', 'ok'))
      c.p.update(toolUpdate('call_e', 'completed', 'ok'))
    })
    const firstP = step(h.adapter, makeOptions('s1'))
    await new Promise(resolve => setTimeout(resolve, 120))
    const pump = TurnPump.forSession('s1')!
    pump.dispatchMcpCall('bash', { command: 'real' }).catch(() => { /* 收尾后可能被拒 */ })
    const chunks = await firstP
    expect(chunks.some(c => c.includes('段一'))).toBe(true)
    expect(chunks.some(c => c.includes('cli_defer_execute_tool'))).toBe(false)
    expect(chunks.some(c => c.includes('cli_mcp__dsh__bash'))).toBe(false)
    expect(chunks.some(c => c.includes('"name":"bash"'))).toBe(true)
    expect(h.registeredTools.has('cli_defer_execute_tool')).toBe(false)
    expect(h.registeredTools.has('cli_mcp__dsh__bash')).toBe(false)
    settleFn?.()
  }, 15_000)

  it('参数平铺在顶层的 DelegateTool 调用 → 兼容解析进 input(实测高频形态)', async () => {
    // 回归:白名单模式下模型高频把 dsh 工具参数与 toolId 平铺
    // (`{"pattern":...,"toolId":"dsh_grep"}`,无 input 包装)——此前直接丢参
    // 导致工具全线报 missing required property。
    const h = makeAdapter({}, { ...FAST, maxAttempts: 1, tailQuietMs: 5_000 })
    let settleFn: (() => void) | undefined
    mockTurn((c) => {
      settleFn = () => c.settle()
      c.p.update(toolCall('call_flat', 'DelegateTool', { pattern: 'boot', path: 'src', toolId: 'dsh_grep' }))
      c.p.update(phase('tool_executing'))
    })
    const chunks = await step(h.adapter, makeOptions('s1'))
    const block = chunks.find(c => c.includes('"name":"grep"'))
    expect(block).toBeDefined()
    // chunk 内 arguments 是二次转义的 JSON 字符串:解析后比对,避免转义断言坑。
    const parsed = JSON.parse(block!) as { block: { arguments: string } }
    expect(JSON.parse(parsed.block.arguments)).toEqual({ pattern: 'boot', path: 'src' })
    settleFn?.()
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
    const tool = h.registeredTools.get('cli_bash')!
    let settled = false
    const waiting = (tool['execute'] as (args: unknown, exec: unknown) => Promise<unknown>)({}, { callId: 'call_1' })
    waiting.then(() => { settled = true }, () => { settled = true })
    await new Promise<void>(resolve => setTimeout(resolve, 30))
    expect(settled).toBe(false) // 仍在等待 ACP 结果
    await vi.waitFor(() => { expect(TurnPump.forSession('s1')).toBeUndefined() }, { timeout: 3_000 })
    await expect(waiting).rejects.toThrow()
  }, 15_000)
})
