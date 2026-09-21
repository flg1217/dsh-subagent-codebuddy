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
  resetTakeoverStateForTests,
} from '../src/compact-command.ts'
import type { CompactCommandDeps, CompactInvocation } from '../src/compact-command.ts'
import {
  isSelfInitiatedCompaction,
  resetSelfInitiatedCompactionsForTests,
} from '../src/self-compaction.ts'
import { asSpawnResult, autoHandshake, fakeAcpProc, usage } from './fake-acp.ts'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn() }
})
const mockedSpawn = vi.mocked(spawn)

beforeEach(() => {
  mockedSpawn.mockReset()
  resetTakeoverStateForTests()
  resetSelfInitiatedCompactionsForTests()
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
  // 压缩实例按 dsh 的官方寻址取:realm 隔离让 `ctx.get('compaction')` 永远拿不到
  // (宿主 ctx 与 agent.ctx 都看不到),只有 `agentPresets.serviceFor(agent, name)` 能。
  const ctx = {
    get: (key: string) => (key === 'agentPresets' ? { serviceFor: () => compaction } : undefined),
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

function makeInvocation(sessionId: string, rawInput = '', provider?: string): CompactInvocation {
  return {
    commandId: 'cmd-1',
    rawInput,
    signal: new AbortController().signal,
    agent: {
      session: {
        id: sessionId,
        header: { cwd: process.cwd() },
        ...provider === undefined ? {} : { requestHeader: () => ({ config: { provider } }) },
      },
    },
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

  it('成功转发后标记该会话(镜像层据此不再重复渲染同一次压缩)', async () => {
    mockCompactCli()
    const deps = makeDeps()
    deps.store.set('s-1', { acpId: 'cb-session-9', sentCount: 1 })

    const result = await forwardCompactToCli(deps, 's-1', process.cwd(), new AbortController().signal)

    expect(result.kind).toBe('success')
    // 本次压缩自己的摘要(CLI 可能在转发期间就打好时间戳)→ 认领并清除标记。
    const now = Date.now()
    expect(isSelfInitiatedCompaction('s-1', now, now)).toBe(true)
    expect(isSelfInitiatedCompaction('s-1', now, now)).toBe(false)
  })

  it('转发失败不标记(没有产出,不该静音镜像)', async () => {
    const deps = makeDeps()

    const result = await forwardCompactToCli(deps, 's-none', process.cwd(), new AbortController().signal)

    expect(result.kind).toBe('error')
    expect(isSelfInitiatedCompaction('s-none', Date.now(), Date.now())).toBe(false)
  })
})

describe('handleCompactCommand:分流', () => {
  /** 带 runMaintenance 面的 invocation(模拟真实 agent:进入 maintenance 后消息排队)。 */
  function makeMaintenanceInvocation(
    sessionId: string,
    options?: { fail?: boolean; provider?: string },
  ): { invocation: CompactInvocation; state: { calls: number } } {
    const state = { calls: 0 }
    const agent = {
      session: {
        id: sessionId,
        header: { cwd: process.cwd() },
        requestHeader: () => ({ config: { provider: options?.provider ?? 'codebuddy' } }),
      },
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
    const result = await handleCompactCommand(deps, makeInvocation('s-1', '', 'codebuddy'))
    expect(result.kind).toBe('success')
    expect(prompts).toEqual(['/compact'])
    expect(compactNow).not.toHaveBeenCalled()
  })

  it('回归:切走 provider 后手动 /compact 回落 dsh(不按会话映射判定)', async () => {
    // 事故(2026-09-21 用户报障):会话**先跑过 codebuddy**(映射记录持久化),
    // 之后切到 cpa。手动 /compact 当时用 `conversations.get(sessionId)` 当判据
    // → 仍被判成 codebuddy 会话 → 转发 CLI(CLI 侧 401)→ 压缩什么都没发生,
    // 会话里一条 compaction/* 都没有。自动路径早已改成按路由判定,手动路径漏改。
    // 判据必须与自动路径统一:最新一次请求的路由 provider。
    mockCompactCli()
    const compactNow = vi.fn().mockResolvedValue({ shadowedSeqs: [1], shadowedTokenCount: 999 })
    const deps = makeDeps({ compactNow })
    deps.store.set('s-1', { acpId: 'cb-1', sentCount: 1 })   // 映射记录仍在
    const result = await handleCompactCommand(deps, makeInvocation('s-1', '', 'cpa'))
    expect(result.kind).toBe('success')
    if (result.kind === 'success') expect(result.text).toContain('999')
    expect(compactNow).toHaveBeenCalledTimes(1)
    expect(mockedSpawn).not.toHaveBeenCalled()
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

  /**
   * 假 ctx:compaction 实例按 dsh 的官方寻址(`agentPresets.serviceFor`)给出,
   * 记录日志、释放函数、serviceFor 调用,并暴露可触发的 agent 事件。
   */
  function makeEngine(engine: FakeEngine = new FakeEngine()): {
    ctx: Context
    engine: FakeEngine
    infos: string[]
    warns: string[]
    serviceForCalls: Array<{ agent: unknown; name: string }>
    release: () => void
    fireCreated: (agent?: unknown) => void
    firePreStep: (agent?: unknown) => Promise<void>
  } {
    const infos: string[] = []
    const warns: string[] = []
    const disposers: Array<() => void> = []
    const created: Array<(payload: unknown) => void> = []
    const preStep: Array<(payload: unknown, next: () => Promise<unknown>) => Promise<unknown> | unknown> = []
    const serviceForCalls: Array<{ agent: unknown; name: string }> = []
    const ctx = {
      effect: (cb: () => () => void) => { disposers.push(cb()) },
      get: (key: string) => (key === 'agentPresets'
        ? {
          serviceFor: (agent: unknown, name: string) => {
            serviceForCalls.push({ agent, name })
            return engine
          },
        }
        : undefined),
      on: (event: string, listener: unknown) => {
        if (event === 'agent/created') created.push(listener as (payload: unknown) => void)
        if (event === 'agent/pre-step') {
          preStep.push(listener as (payload: unknown, next: () => Promise<unknown>) => Promise<unknown> | unknown)
        }
        return () => {}
      },
      logger: { info: (message: string) => { infos.push(message) }, warn: (message: string) => { warns.push(message) } },
    } as unknown as Context
    return {
      ctx,
      engine,
      infos,
      warns,
      serviceForCalls,
      release: () => { for (const dispose of disposers) dispose() },
      fireCreated: (agent: unknown = agentOf('codebuddy')) => { for (const listener of created) listener({ agent }) },
      firePreStep: async (agent: unknown = agentOf('codebuddy')) => {
        for (const listener of preStep) await listener({ agent }, async () => ({}))
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
    const { ctx, engine, fireCreated } = makeEngine()
    registerCompactDelegation({ ...deps, ctx })
    fireCreated()
    expect(await engine.compactIfNeeded(agentOf('codebuddy'), 'pressure', signal())).toBeNull()
    expect(engine.calls).toBe(0)
  })

  it('按 agent 寻址:实例来自 agentPresets.serviceFor(agent, "compaction")', async () => {
    // realm 隔离让宿主 ctx 与 agent.ctx 都看不到 compaction(实测:线上 inject 不触发、
    // ctx.get 也是 undefined),官方通道是名册的 serviceFor——它按 fiber 归属找出该
    // 会话 preset 发布的那一个实例。接管必须走这条路,不能靠猜 scope。
    const deps = makeDeps()
    const { ctx, engine, serviceForCalls, fireCreated } = makeEngine()
    registerCompactDelegation({ ...deps, ctx })
    const agent = agentOf('codebuddy')
    fireCreated(agent)
    expect(serviceForCalls).toEqual([{ agent, name: 'compaction' }])
    expect(await engine.compactIfNeeded(agent, 'pressure', signal())).toBeNull()
  })

  it('agent/created 即接管,且 step 边界复核幂等(不重复包装)', async () => {
    // compaction 的 pre-step 监听器注册得比我们早:接管晚一步,那一轮就已经被
    // dsh 压过一次。所以 agent/created 就要装上;复核必须幂等——包装两层会让
    // "原方法"变成上一层的包装,非 codebuddy 会话就会多绕一圈。
    const deps = makeDeps()
    const { ctx, engine, fireCreated, firePreStep } = makeEngine()
    registerCompactDelegation({ ...deps, ctx })
    fireCreated()
    expect(await engine.compactIfNeeded(agentOf('codebuddy'), 'pressure', signal())).toBeNull()
    await firePreStep()
    expect(await engine.compactIfNeeded(agentOf('codebuddy'), 'pressure', signal())).toBeNull()
    expect(await engine.compactIfNeeded(agentOf('cpa'), 'pressure', signal())).toEqual({ compacted: true })
    expect(engine.calls).toBe(1)
  })

  it('非 codebuddy 路由 → 原样下调原方法(内置压缩不动)', async () => {
    const deps = makeDeps()
    const { ctx, engine, fireCreated } = makeEngine()
    registerCompactDelegation({ ...deps, ctx })
    fireCreated()
    expect(await engine.compactIfNeeded(agentOf('cpa'), 'pressure', signal()))
      .toEqual({ compacted: true })
    expect(engine.calls).toBe(1)
  })

  it('回归:按当轮路由判定,不按会话映射(映射记录是持久化的、切走 provider 后仍在)', async () => {
    // 若按 conversations 判定,用户把 codebuddy 会话切回别的 provider 后 dsh 会
    // 永不压缩(映射记录不会消失)。判据必须是最新请求的路由 provider。
    const deps = makeDeps()
    deps.store.set('s-1', { acpId: 'cb-1', sentCount: 1 })
    const { ctx, engine, fireCreated } = makeEngine()
    registerCompactDelegation({ ...deps, ctx })
    fireCreated()
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
    const { ctx, engine, fireCreated } = makeEngine()
    registerCompactDelegation({ ...deps, ctx })
    fireCreated()
    expect(await engine.compactIfNeeded(agentOf('codebuddy'), 'pressure', signal())).toBeNull()
    expect(await engine.compactIfNeeded(agentOf('codebuddy'), 'context-overflow', signal())).toBeNull()
    expect(engine.calls).toBe(0)
    expect(mockedSpawn).not.toHaveBeenCalled()
  })

  it('cordis 追踪代理:覆盖必须落到真实实例(代理上 identity 永远不等)', async () => {
    // `Service` 实例带 symbols.tracker,经 getTraceable 读出来是追踪代理:get 对函数
    // 属性每次返回新的 shadow 包装(identity 必然不等),set 把值写到 shadow 而不是
    // 实例。线上实测就是在这上面报的"不可覆写"——覆盖前必须先解包 symbols.original。
    // 自动路径调的是实例自己的方法,所以覆盖落在 raw 上才算数。
    const deps = makeDeps()
    const raw = new FakeEngine()
    const shadow: Record<string, unknown> = {}
    const proxy = new Proxy(raw, {
      get: (target, key, receiver) => {
        if (key === symbols.original) return target
        const value = Reflect.get(target, key, receiver)
        return typeof value === 'function'
          ? (...args: unknown[]) => (value as (...a: unknown[]) => unknown).apply(target, args)
          : value
      },
      set: (_target, key, value) => { shadow[String(key)] = value; return true },
    })
    const { ctx, fireCreated } = makeEngine(proxy as unknown as FakeEngine)
    registerCompactDelegation({ ...deps, ctx })
    fireCreated()
    expect(await raw.compactIfNeeded(agentOf('codebuddy'), 'pressure', signal())).toBeNull()
    expect(raw.calls).toBe(0)
    expect(await raw.compactIfNeeded(agentOf('cpa'), 'pressure', signal())).toEqual({ compacted: true })
    expect(raw.calls).toBe(1)
  })

  it('自愈:接管丢失后,step 边界复核就地重装', async () => {
    const deps = makeDeps()
    const { ctx, engine, fireCreated, firePreStep } = makeEngine()
    registerCompactDelegation({ ...deps, ctx })
    fireCreated()
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
    const { ctx, engine, fireCreated, release } = makeEngine()
    registerCompactDelegation({ ...deps, ctx })
    fireCreated()
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
    const { ctx, engine, fireCreated } = makeEngine()
    registerCompactDelegation({ ...deps, ctx })
    fireCreated()
    expect(await engine.compactNow(agentOf('codebuddy'), signal(), 'cmd-1')).toBeNull()
    expect(engine.manualCalls).toBe(0)
  })

  it('手动路径兜底:非 codebuddy 路由的 compactNow 原样下调', async () => {
    const deps = makeDeps()
    const { ctx, engine, fireCreated } = makeEngine()
    registerCompactDelegation({ ...deps, ctx })
    fireCreated()
    expect(await engine.compactNow(agentOf('cpa'), signal(), 'cmd-1'))
      .toEqual({ compactedManually: true })
    expect(engine.manualCalls).toBe(1)
  })

  it('自检:接管失败要吵出来(不静默失效 → 压缩风暴复现)', () => {
    // dsh 若把 compactIfNeeded 改名/改成不可覆写,接管会静默失效。用不可写的实例
    // 属性模拟,断言必须落一条 warn——而不是安静地不压(那正是线上踩过的坑)。
    const deps = makeDeps()
    const engine = Object.defineProperty({}, 'compactIfNeeded', {
      value: async (): Promise<unknown> => ({}),
      writable: false,
      configurable: false,
    })
    const { ctx, warns, fireCreated } = makeEngine(engine as unknown as FakeEngine)
    registerCompactDelegation({ ...deps, ctx })
    fireCreated()
    expect(warns.some(message => message.includes('未生效'))).toBe(true)
    // 告警要带失败原因(只报"没生效"没法定位,线上踩过)。
    expect(warns.some(message => message.includes('抛错'))).toBe(true)
  })

  it('接管生效时播报一次(每个会话一次),日志缺失也不炸', async () => {
    const deps = makeDeps()
    const { ctx, engine, infos, fireCreated } = makeEngine()
    registerCompactDelegation({ ...deps, ctx })
    fireCreated()
    await engine.compactIfNeeded(agentOf('codebuddy', 's-announce'), 'pressure', signal())
    await engine.compactIfNeeded(agentOf('codebuddy', 's-announce'), 'context-overflow', signal())
    expect(infos.filter(message => message.includes('已接管')).length).toBe(1)

    // 没有 logger 的 ctx 不得抛错(日志不该拖垮接管)。
    const bare = {
      effect: () => {},
      get: () => ({ serviceFor: () => engine }),
      on: () => () => {},
    } as unknown as Context
    expect(() => registerCompactDelegation({ ...deps, ctx: bare })).not.toThrow()
  })

  it('旧版 dsh 没有名册服务 → 不炸,且只告警一次(不刷屏)', () => {
    const deps = makeDeps()
    const warns: string[] = []
    const ctx = {
      get: () => undefined,
      on: (event: string, listener: (payload: unknown) => void) => {
        if (event === 'agent/created') listener({ agent: agentOf('codebuddy') })
        return () => {}
      },
      logger: { info: () => {}, warn: (message: string) => { warns.push(message) } },
    } as unknown as Context
    expect(() => registerCompactDelegation({ ...deps, ctx })).not.toThrow()
    expect(warns.filter(message => message.includes('agentPresets')).length).toBe(1)
  })

  it('rosterless 部署(没有 preset 名册):退回宿主平面的 compaction', async () => {
    // 没有 preset 的部署里,模型面插件直接挂在宿主组合里,compaction 就在宿主平面
    // (插件 ctx 自己看得到)。这条路不能丢:否则这类部署照样压缩风暴。
    const deps = makeDeps()
    const engine = new FakeEngine()
    const created: Array<(payload: unknown) => void> = []
    const ctx = {
      get: (key: string) => (key === 'compaction' ? engine : undefined),
      effect: () => {},
      on: (event: string, listener: (payload: unknown) => void) => {
        if (event === 'agent/created') created.push(listener)
        return () => {}
      },
    } as unknown as Context
    registerCompactDelegation({ ...deps, ctx })
    for (const listener of created) listener({ agent: agentOf('codebuddy') })
    expect(await engine.compactIfNeeded(agentOf('codebuddy'), 'pressure', signal())).toBeNull()
    expect(engine.calls).toBe(0)
  })

  it('preset 未挂 compaction(serviceFor 返回 undefined)→ 不炸,也不算"失效"', () => {
    // 没有 compaction 服务的 preset 本来就压不动,不存在压缩风暴:这种情况不该报
    // "接管未生效"级别的告警(否则日志里全是假警报)。
    const deps = makeDeps()
    const warns: string[] = []
    const ctx = {
      get: (key: string) => (key === 'agentPresets' ? { serviceFor: () => undefined } : undefined),
      on: (event: string, listener: (payload: unknown) => void) => {
        if (event === 'agent/created') listener({ agent: agentOf('codebuddy') })
        return () => {}
      },
      logger: { info: () => {}, warn: (message: string) => { warns.push(message) } },
    } as unknown as Context
    expect(() => registerCompactDelegation({ ...deps, ctx })).not.toThrow()
    expect(warns.some(message => message.includes('未生效'))).toBe(false)
  })
})
