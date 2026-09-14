/**
 * `/compact` 的 CodeBuddy 转发:
 * - 短连接 resume 该会话并把 `/compact` 作为 CLI 用户命令发出(CLI 压它自己的历史);
 * - 分流(codebuddy 会话转发;其它会话回落 dsh 压缩;带参报 usage);
 * - **压缩跑在 agent 的 maintenance 相位里**:压缩期间发来的消息按原生行为排队,
 *   不会开新回合抢跑(抢跑那一轮会和压缩并发写同一个 CLI 会话、盖掉压缩结果);
 * - 自动压缩接管:codebuddy 路由的会话**一律返回 null 且不启动 CLI**——dsh 只是
 *   渲染层,真实压缩由 CLI 自行完成;dsh 若压,会把镜像消息从 UI 上抹掉、压不动
 *   真实压力,而且每个 step 反复触发(压缩风暴)。非 codebuddy 路由原样下调原方法;
 * - per-agent 命令挂载(agent.ctx 上注册 `compact`)。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { spawn } from 'node:child_process'
import { symbols } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { ConversationStore } from '../src/conversations.ts'
import {
  forwardCompactToCli,
  handleCompactCommand,
  mountCompactCommand,
  registerCompactDelegation,
} from '../src/compact-command.ts'
import type { CompactCommandDeps, CompactInvocation } from '../src/compact-command.ts'
import { asSpawnResult, autoHandshake, fakeAcpProc, usage } from './fake-acp.ts'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn() }
})
const mockedSpawn = vi.mocked(spawn)

beforeEach(() => {
  mockedSpawn.mockReset()
})

/** 内存态会话映射(不落盘)。 */
function makeStore(): ConversationStore {
  return new ConversationStore(null)
}

/** 捕获转发内容的假 CLI:握手自动,`session/prompt` 记录文本并收尾。 */
function mockCompactCli(): { prompts: string[]; loads: string[] } {
  const prompts: string[] = []
  const loads: string[] = []
  mockedSpawn.mockImplementation(() => {
    const p = fakeAcpProc()
    autoHandshake(p)
    p.onRequest(request => {
      if (request.method === 'session/load') loads.push(String(request.params['sessionId']))
      if (request.method !== 'session/prompt') return
      prompts.push((request.params['prompt'] as Array<{ text: string }>)[0]!.text)
      p.respond(request.id, { stopReason: 'end_turn' })
    })
    return asSpawnResult(p)
  })
  return { prompts, loads }
}

/** 压缩期间吐一条 usage 的假 CLI(压缩前上下文规模)。 */
function mockCompactCliWithUsage(promptTokens: number, cacheHit: number): void {
  mockedSpawn.mockImplementation(() => {
    const p = fakeAcpProc()
    autoHandshake(p)
    p.onRequest(request => {
      if (request.method !== 'session/prompt') return
      p.update(usage({ prompt_tokens: promptTokens, prompt_cache_hit_tokens: cacheHit }))
      p.respond(request.id, { stopReason: 'end_turn' })
    })
    return asSpawnResult(p)
  })
}

function makeDeps(compaction?: unknown): CompactCommandDeps & { store: ConversationStore } {
  const store = makeStore()
  const ctx = {
    get: (key: string) => (key === 'compaction' ? compaction : undefined),
  } as unknown as Context
  return {
    ctx,
    command: 'codebuddy.js',
    prefixArgs: [],
    extraArgs: [],
    modelOf: () => 'glm-5.3',
    conversations: store,
    providerName: 'codebuddy',
    store,
  }
}

function makeInvocation(sessionId: string, rawInput = ''): CompactInvocation {
  return {
    commandId: 'cmd-1',
    rawInput,
    signal: new AbortController().signal,
    agent: { session: { id: sessionId, header: { cwd: process.cwd() } } },
  }
}

describe('forwardCompactToCli:转发 /compact', () => {
  it('resume 已登记的 CLI 会话,并把 /compact 作为 prompt 发出', async () => {
    const { prompts, loads } = mockCompactCli()
    const deps = makeDeps()
    deps.store.set('s-1', { acpId: 'cb-session-9', sentCount: 3 })
    const result = await forwardCompactToCli(deps, 's-1', process.cwd(), new AbortController().signal)
    expect(result.kind).toBe('success')
    expect(prompts).toEqual(['/compact'])
    expect(loads).toEqual(['cb-session-9'])
  })

  it('未登记的会话 → 明确错误,不启动 CLI', async () => {
    const deps = makeDeps()
    const result = await forwardCompactToCli(deps, 's-none', process.cwd(), new AbortController().signal)
    expect(result.kind).toBe('error')
    if (result.kind === 'error') expect(result.text).toContain('还没有 CodeBuddy CLI 会话')
    expect(mockedSpawn).not.toHaveBeenCalled()
  })

  it('回合运行中(泵活跃)→ 拒绝转发,不启动第二条 CLI 连接', async () => {
    const deps = makeDeps()
    deps.store.set('s-1', { acpId: 'cb-session-9', sentCount: 3 })
    deps.isSessionBusy = () => true
    const result = await forwardCompactToCli(deps, 's-1', process.cwd(), new AbortController().signal)
    expect(result.kind).toBe('error')
    if (result.kind === 'error') expect(result.text).toContain('回合正在运行中')
    expect(mockedSpawn).not.toHaveBeenCalled()

    // 泵空闲(默认查询)照常转发。
    deps.isSessionBusy = undefined
    mockCompactCli()
    const free = await forwardCompactToCli(deps, 's-1', process.cwd(), new AbortController().signal)
    expect(free.kind).toBe('success')
  })

  it('压缩期间报出压缩前上下文规模(用户可核对)', async () => {
    mockCompactCliWithUsage(611410, 610176)
    const deps = makeDeps()
    deps.store.set('s-1', { acpId: 'cb-1', sentCount: 1 })
    const result = await forwardCompactToCli(deps, 's-1', process.cwd(), new AbortController().signal)
    expect(result.kind).toBe('success')
    if (result.kind === 'success') expect(result.text).toContain('611K')
  })
})

describe('handleCompactCommand:分流', () => {
  /** 带 runMaintenance 面的 invocation(模拟真实 agent:进入 maintenance 后消息排队)。 */
  function makeMaintenanceInvocation(
    sessionId: string,
    options?: { fail?: boolean },
  ): { invocation: CompactInvocation; state: { calls: number } } {
    const state = { calls: 0 }
    const agent = {
      session: { id: sessionId, header: { cwd: process.cwd() } },
      runMaintenance: async <T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> => {
        state.calls += 1
        if (options?.fail === true) throw new Error(`agent "${sessionId}" already has active work`)
        return await job(new AbortController().signal)
      },
    }
    return {
      invocation: {
        commandId: 'cmd-1',
        rawInput: '',
        signal: new AbortController().signal,
        agent: agent as unknown as CompactInvocation['agent'],
      },
      state,
    }
  }

  it('带参数的 /compact → usage 错误,不动作', async () => {
    mockCompactCli()
    const deps = makeDeps()
    deps.store.set('s-1', { acpId: 'cb-1', sentCount: 1 })
    const result = await handleCompactCommand(deps, makeInvocation('s-1', ' 现在压'))
    expect(result.kind).toBe('error')
    expect(mockedSpawn).not.toHaveBeenCalled()
  })

  it('codebuddy 会话 → 转发 CLI(不再触碰 dsh 压缩)', async () => {
    const { prompts } = mockCompactCli()
    const compactNow = vi.fn()
    const deps = makeDeps({ compactNow })
    deps.store.set('s-1', { acpId: 'cb-1', sentCount: 1 })
    const result = await handleCompactCommand(deps, makeInvocation('s-1'))
    expect(result.kind).toBe('success')
    expect(prompts).toEqual(['/compact'])
    expect(compactNow).not.toHaveBeenCalled()
  })

  it('非 codebuddy 会话 → 回落 dsh 压缩(行为不变)', async () => {
    const compactNow = vi.fn().mockResolvedValue({ shadowedSeqs: [1, 2], shadowedTokenCount: 1234 })
    const deps = makeDeps({ compactNow })
    const result = await handleCompactCommand(deps, makeInvocation('plain-session'))
    expect(result.kind).toBe('success')
    if (result.kind === 'success') expect(result.text).toContain('1234')
    expect(compactNow).toHaveBeenCalledTimes(1)
    expect(mockedSpawn).not.toHaveBeenCalled()
  })

  it('dsh 压缩服务缺失时给出错误而不是抛出', async () => {
    const deps = makeDeps(undefined)
    const result = await handleCompactCommand(deps, makeInvocation('plain-session'))
    expect(result.kind).toBe('error')
  })

  it('压缩跑在 agent 的 maintenance 相位里(消息排队,不抢跑)', async () => {
    const { prompts } = mockCompactCli()
    const deps = makeDeps()
    deps.store.set('s-1', { acpId: 'cb-1', sentCount: 1 })
    const { invocation, state } = makeMaintenanceInvocation('s-1')
    const result = await handleCompactCommand(deps, invocation)
    expect(result.kind).toBe('success')
    expect(state.calls).toBe(1)
    expect(prompts).toEqual(['/compact'])
  })

  it('agent 非 idle(runMaintenance 抛错)→ 明确"回合运行中"错误,不启动 CLI', async () => {
    mockCompactCli()
    const deps = makeDeps()
    deps.store.set('s-1', { acpId: 'cb-1', sentCount: 1 })
    const { invocation } = makeMaintenanceInvocation('s-1', { fail: true })
    const result = await handleCompactCommand(deps, invocation)
    expect(result.kind).toBe('error')
    if (result.kind === 'error') expect(result.text).toContain('回合正在运行中')
    expect(mockedSpawn).not.toHaveBeenCalled()
  })
})

describe('mountCompactCommand:per-agent 挂载', () => {
  it('agent/created 时在该 agent 的 ctx 注册 compact 命令', () => {
    const deps = makeDeps()
    const listeners = new Map<string, (payload: unknown) => void>()
    const registerCalls: Array<{ name: string }> = []
    const mountCtx = {
      inject: (_deps: string[], cb: (ctx: unknown) => void) => { cb(mountCtx) },
      on: (event: string, handler: (payload: unknown) => void) => { listeners.set(event, handler) },
    } as unknown as Context
    mountCompactCommand({ ...deps, ctx: mountCtx })
    expect(listeners.has('agent/created')).toBe(true)
    listeners.get('agent/created')!({
      agent: {
        ctx: {
          inject: (_deps: string[], cb: (scoped: unknown) => void) => cb({
            commands: {
              register: (definition: { name: string }) => {
                registerCalls.push(definition)
                return () => {}
              },
            },
          }),
        },
      },
    })
    expect(registerCalls.map(call => call.name)).toEqual(['compact'])
    // 没有 commands 面的 agent 不炸。
    expect(() => listeners.get('agent/created')!({ agent: {} })).not.toThrow()
  })
})

describe('registerCompactDelegation:压缩接管', () => {
  /** 原型方法 + 调用计数的假 compaction 服务(接管后自有属性遮蔽原型)。 */
  class FakeEngine {
    calls = 0
    manualCalls = 0
    async compactIfNeeded(_agent?: unknown, _trigger?: string, _signal?: AbortSignal): Promise<unknown> {
      this.calls += 1
      return { compacted: true }
    }

    async compactNow(_agent?: unknown, _signal?: AbortSignal, _commandId?: string): Promise<unknown> {
      this.manualCalls += 1
      return { compactedManually: true }
    }
  }

  /** 假 compaction 服务 + 立即回调的 inject + 收集释放函数的 effect + 可触发的 pre-step。 */
  function makeEngine(): {
    ctx: Context
    engine: FakeEngine
    release: () => void
    firePreStep: () => Promise<void>
  } {
    const engine = new FakeEngine()
    const disposers: Array<() => void> = []
    const preStep: Array<(payload: unknown, next: () => Promise<unknown>) => Promise<unknown> | unknown> = []
    const ctx = {
      inject: (_deps: string[], cb: (scoped: unknown) => void) => { cb({ compaction: engine }) },
      effect: (cb: () => () => void) => { disposers.push(cb()) },
      get: (key: string) => (key === 'compaction' ? engine : undefined),
      on: (event: string, listener: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown> | unknown) => {
        if (event === 'agent/pre-step') preStep.push(listener)
        return () => {}
      },
    } as unknown as Context
    return {
      ctx,
      engine,
      release: () => { for (const dispose of disposers) dispose() },
      firePreStep: async () => {
        for (const listener of preStep) await listener({}, async () => ({}))
      },
    }
  }

  /** 按"最新一次请求的路由 provider"回答的会话面。 */
  function agentOf(provider: string | undefined, id = 's-1'): unknown {
    return {
      session: {
        id,
        requestHeader: () => (provider === undefined ? undefined : { config: { provider } }),
      },
    }
  }

  const signal = (): AbortSignal => new AbortController().signal

  it('codebuddy 路由的会话 → 接管:返回 null,dsh 不压缩', async () => {
    // 设计:dsh 只是渲染层,真实上下文与压缩都由 CLI 自己负责。接管自动压缩入口
    // 后 compaction-basic 的两条自动路径都拿不到结果,不会碰会话镜像面。
    const deps = makeDeps()
    const { ctx, engine } = makeEngine()
    registerCompactDelegation({ ...deps, ctx })
    expect(await engine.compactIfNeeded(agentOf('codebuddy'), 'pressure', signal())).toBeNull()
    expect(engine.calls).toBe(0)
  })

  it('非 codebuddy 路由 → 原样下调原方法(内置压缩不动)', async () => {
    const deps = makeDeps()
    const { ctx, engine } = makeEngine()
    registerCompactDelegation({ ...deps, ctx })
    expect(await engine.compactIfNeeded(agentOf('cpa'), 'pressure', signal()))
      .toEqual({ compacted: true })
    expect(engine.calls).toBe(1)
  })

  it('回归:按当轮路由判定,不按会话映射(映射记录是持久化的、切走 provider 后仍在)', async () => {
    // 若按 conversations 判定,用户把 codebuddy 会话切回别的 provider 后 dsh 会
    // 永不压缩(映射记录不会消失)。判据必须是最新请求的路由 provider。
    const deps = makeDeps()
    deps.store.set('s-1', { acpId: 'cb-1', sentCount: 1 })
    const { ctx, engine } = makeEngine()
    registerCompactDelegation({ ...deps, ctx })
    expect(await engine.compactIfNeeded(agentOf('codebuddy'), 'pressure', signal())).toBeNull()
    expect(await engine.compactIfNeeded(agentOf('cpa'), 'pressure', signal()))
      .toEqual({ compacted: true })
    expect(engine.calls).toBe(1)
  })

  it('回归:自动路径绝不启动 CLI 连接,压力/溢出两条触发都接管', async () => {
    // **本用例是"压缩风暴 + 镜像消息从 UI 消失"的回归防线。** 触发点都在回合中
    // (`agent/pre-step` 的 pressure / `agent/request-error` 的 overflow),此时
    // runMaintenance 不可用(agent-loop/src/agent.ts:157);既不能回落 dsh 内置
    // 压缩(压不动真实压力、每个 step 反复触发,并把镜像消息替换成摘要),
    // 也不能另开 CLI 连接(会与回合泵持有的同一会话冲突)。
    mockCompactCli()
    const deps = makeDeps()
    const { ctx, engine } = makeEngine()
    registerCompactDelegation({ ...deps, ctx })
    expect(await engine.compactIfNeeded(agentOf('codebuddy'), 'pressure', signal())).toBeNull()
    expect(await engine.compactIfNeeded(agentOf('codebuddy'), 'context-overflow', signal())).toBeNull()
    expect(engine.calls).toBe(0)
    expect(mockedSpawn).not.toHaveBeenCalled()
  })

  it('cordis 追踪代理:接管必须落到真实实例(代理读回看不到自有属性)', async () => {
    // 回归:`ctx.compaction` 是 cordis 代理——读解析原型方法、写转发到实例。若把
    // 代理当真实实例校验,会误判"不可覆写"并放弃接管(线上压缩风暴的成因之一)。
    const deps = makeDeps()
    const engine = new FakeEngine()
    const proxy = new Proxy(engine, {
      get: (target, key, receiver) => (key === symbols.original ? target : Reflect.get(target, key, receiver)),
      set: (target, key, value) => Reflect.set(target, key, value),
    })
    const ctx = {
      inject: (_deps: string[], cb: (scoped: unknown) => void) => cb({ compaction: proxy }),
      effect: () => {},
      get: () => proxy,
      on: () => () => {},
    } as unknown as Context
    registerCompactDelegation({ ...deps, ctx })
    expect(await engine.compactIfNeeded(agentOf('codebuddy'), 'pressure', signal())).toBeNull()
    expect(engine.calls).toBe(0)
  })

  it('自愈:接管丢失后,step 边界复核就地重装', async () => {
    const deps = makeDeps()
    const { ctx, engine, firePreStep } = makeEngine()
    registerCompactDelegation({ ...deps, ctx })
    expect(await engine.compactIfNeeded(agentOf('codebuddy'), 'pressure', signal())).toBeNull()
    // 模拟接管丢失(服务被替换 / 属性被清):原型方法重新生效。
    delete (engine as unknown as Record<string, unknown>)['compactIfNeeded']
    expect(await engine.compactIfNeeded(agentOf('codebuddy'), 'pressure', signal()))
      .toEqual({ compacted: true })
    // 下一个 step 边界复核 → 重装 → 继续接管。
    await firePreStep()
    expect(await engine.compactIfNeeded(agentOf('codebuddy'), 'pressure', signal())).toBeNull()
    expect(engine.calls).toBe(1)
  })

  it('插件卸载/热重载 → 还原原型方法(不留接管)', async () => {
    const deps = makeDeps()
    const { ctx, engine, release } = makeEngine()
    registerCompactDelegation({ ...deps, ctx })
    expect(await engine.compactIfNeeded(agentOf('codebuddy'), 'pressure', signal())).toBeNull()
    release()
    expect(await engine.compactIfNeeded(agentOf('codebuddy'), 'pressure', signal()))
      .toEqual({ compacted: true })
    expect(engine.calls).toBe(1)
  })

  it('手动路径兜底:codebuddy 路由的 compactNow 也不压 dsh 镜像', async () => {
    // per-agent 的 `compact` 命令覆盖没挂上时,全局 /compact 会走 compactNow。
    // 那条路同样不许压镜像(压缩是 CLI 的事)。
    const deps = makeDeps()
    const { ctx, engine } = makeEngine()
    registerCompactDelegation({ ...deps, ctx })
    expect(await engine.compactNow(agentOf('codebuddy'), signal(), 'cmd-1')).toBeNull()
    expect(engine.manualCalls).toBe(0)
  })

  it('手动路径兜底:非 codebuddy 路由的 compactNow 原样下调', async () => {
    const deps = makeDeps()
    const { ctx, engine } = makeEngine()
    registerCompactDelegation({ ...deps, ctx })
    expect(await engine.compactNow(agentOf('cpa'), signal(), 'cmd-1'))
      .toEqual({ compactedManually: true })
    expect(engine.manualCalls).toBe(1)
  })

  it('自检:接管失败要吵出来(不静默失效 → 压缩风暴复现)', () => {
    // dsh 若把 compactIfNeeded 改成实例自有属性/改名,接管会静默失效。用不可写
    // 的实例属性模拟,断言必须落一条 warn。
    const deps = makeDeps()
    const warns: string[] = []
    const engine = Object.defineProperty({}, 'compactIfNeeded', {
      value: async (): Promise<unknown> => ({}),
      writable: false,
      configurable: false,
    })
    const ctx = {
      inject: (_deps: string[], cb: (scoped: unknown) => void) => cb({ compaction: engine }),
      get: () => engine,
      effect: () => {},
      on: () => () => {},
      logger: { info: () => {}, warn: (message: string) => { warns.push(message) } },
    } as unknown as Context
    registerCompactDelegation({ ...deps, ctx })
    expect(warns.some(message => message.includes('未生效'))).toBe(true)
  })

  it('接管生效时播报一次(每个会话一次),日志缺失也不炸', async () => {
    const deps = makeDeps()
    const infos: string[] = []
    const engine = new FakeEngine()
    const ctx = {
      inject: (_deps: string[], cb: (scoped: unknown) => void) => cb({ compaction: engine }),
      get: () => engine,
      effect: () => {},
      on: () => () => {},
      logger: { info: (message: string) => { infos.push(message) }, warn: () => {} },
    } as unknown as Context
    registerCompactDelegation({ ...deps, ctx })
    await engine.compactIfNeeded(agentOf('codebuddy', 's-announce'), 'pressure', signal())
    await engine.compactIfNeeded(agentOf('codebuddy', 's-announce'), 'context-overflow', signal())
    expect(infos.filter(message => message.includes('已接管')).length).toBe(1)

    // 没有 logger 的 ctx 不得抛错(日志不该拖垮接管)。
    const bare = makeEngine()
    const bareCtx = { ...(bare.ctx as unknown as Record<string, unknown>) }
    expect(() => registerCompactDelegation({ ...deps, ctx: bareCtx as unknown as Context })).not.toThrow()
  })

  it('拿不到 compaction 服务的 ctx 不炸(旧版 dsh / 服务未装载)', () => {
    const deps = makeDeps()
    const ctx = {
      inject: (_deps: string[], cb: (scoped: unknown) => void) => cb({}),
      effect: () => {},
      get: () => undefined,
      on: () => () => {},
    } as unknown as Context
    expect(() => registerCompactDelegation({ ...deps, ctx })).not.toThrow()
  })
})
