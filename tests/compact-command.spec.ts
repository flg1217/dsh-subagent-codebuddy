/**
 * `/compact` 的 CodeBuddy 转发:
 * - 短连接 resume 该会话并把 `/compact` 作为 CLI 用户命令发出(CLI 压它自己的历史);
 * - 分流(codebuddy 会话转发;其它会话回落 dsh 压缩;带参报 usage);
 * - **压缩跑在 agent 的 maintenance 相位里**:压缩期间发来的消息按原生行为排队,
 *   不会开新回合抢跑(抢跑那一轮会和压缩并发写同一个 CLI 会话、盖掉压缩结果);
 * - 自动压缩委托:转发成功回报 handled,失败回落 next();
 * - per-agent 命令挂载(agent.ctx 上注册 `compact`)。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { spawn } from 'node:child_process'
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

describe('registerCompactDelegation:自动压缩委托', () => {
  /** 捕获 compaction/delegate 监听的假 ctx。 */
  function makeWatcher(): {
    ctx: Context
    fire: (request: unknown, next: () => Promise<unknown>) => Promise<unknown>
  } {
    let captured: ((request: unknown, next: () => Promise<unknown>) => Promise<unknown>) | undefined
    const ctx = {
      on: (event: string, handler: typeof captured) => {
        if (event === 'compaction/delegate') captured = handler
      },
      get: () => undefined,
    } as unknown as Context
    return { ctx, fire: async (request, next) => await captured!(request, next) }
  }

  it('codebuddy 会话 → 转发 CLI 并回报 handled(不触发 next)', async () => {
    const { prompts } = mockCompactCli()
    const deps = makeDeps()
    deps.store.set('s-1', { acpId: 'cb-1', sentCount: 1 })
    const watcher = makeWatcher()
    registerCompactDelegation({ ...deps, ctx: watcher.ctx })
    const next = vi.fn().mockResolvedValue({ handled: false })
    const result = await watcher.fire(
      { agent: { session: { id: 's-1', header: { cwd: process.cwd() } } }, signal: new AbortController().signal },
      next,
    )
    expect(result).toEqual({ handled: true })
    expect(prompts).toEqual(['/compact'])
    expect(next).not.toHaveBeenCalled()
  })

  it('非 codebuddy 会话 → 原样下调 next(内置压缩不动)', async () => {
    mockCompactCli()
    const deps = makeDeps()
    const watcher = makeWatcher()
    registerCompactDelegation({ ...deps, ctx: watcher.ctx })
    const next = vi.fn().mockResolvedValue(undefined)
    const result = await watcher.fire({ agent: { session: { id: 'plain' } }, signal: new AbortController().signal }, next)
    expect(result).toBeUndefined()
    expect(next).toHaveBeenCalledTimes(1)
    expect(mockedSpawn).not.toHaveBeenCalled()
  })

  it('转发失败(CLI 握手报错)→ 回落 next', async () => {
    mockedSpawn.mockImplementation(() => {
      const p = fakeAcpProc()
      p.onRequest(request => {
        if (request.method === 'initialize') p.respond(request.id, {})
        else if (request.method === 'session/load') p.respondError(request.id, { code: -1, message: 'no such session' })
      })
      return asSpawnResult(p)
    })
    const deps = makeDeps()
    deps.store.set('s-1', { acpId: 'cb-1', sentCount: 1 })
    const watcher = makeWatcher()
    registerCompactDelegation({ ...deps, ctx: watcher.ctx })
    const next = vi.fn().mockResolvedValue({ handled: false })
    const result = await watcher.fire({ agent: { session: { id: 's-1', header: { cwd: process.cwd() } } }, signal: new AbortController().signal }, next)
    expect(result).toEqual({ handled: false })
    expect(next).toHaveBeenCalledTimes(1)
  }, 15_000)
})
