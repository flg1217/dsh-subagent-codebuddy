/**
 * CodebuddyLlmAdapter(ACP 模式)测试。
 * mock spawn:双向 JSON-RPC(ndjson)——stdin 收 adapter 请求,stdout 按脚本回响应/推 update。
 */
import { EventEmitter } from 'node:events'
import type { Readable, Writable } from 'node:stream'
import { Readable as ReadableStream, Readable } from 'node:stream'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { CodebuddyLlmAdapter } from '../src/adapter.ts'
 import { ConversationStore } from '../src/conversations.ts'
import { DEFAULT_ACP_RUN_TIMEOUTS, usageOfUpdate } from '../src/acp.ts'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn() }
})
const { spawn } = await import('node:child_process')
const mockedSpawn = vi.mocked(spawn)

interface FakeAcp {
  proc: EventEmitter & { stdin: Writable; stdout: Readable; stderr: Readable; kill: () => void }
  onRequest(handler: (msg: { id?: number; method: string; params: Record<string, unknown> }) => void): void
  respond(id: number, result: unknown): void
  update(update: Record<string, unknown>): void
  close(code: number | null): void
  requestLog(): string[]
  notifications(): Array<{ method: string; params: Record<string, unknown> }>
}

let lastFake: FakeAcp | undefined

function fakeAcpProc(): FakeAcp {
  const proc = new EventEmitter() as FakeAcp['proc']
  const stdout = new Readable({ read(): void {} })
  const stderr = new Readable({ read(): void {} })
  let stdinBuffer = ''
  const requests: Array<{ id: number; method: string }> = []
  const notifs: Array<{ method: string; params: Record<string, unknown> }> = []
  let handler: (msg: { id?: number; method: string; params: Record<string, unknown> }) => void = () => {}
  const stdin = new ReadableStream({ read(): void {} }) as unknown as Writable
  ;(stdin as unknown as { write: (s: string) => void }).write = (s: string): void => {
    stdinBuffer += s
    let idx: number
    while ((idx = stdinBuffer.indexOf('\n')) >= 0) {
      const line = stdinBuffer.slice(0, idx)
      stdinBuffer = stdinBuffer.slice(idx + 1)
      if (!line.trim().startsWith('{')) continue
      const msg = JSON.parse(line) as { id?: number; method?: string; params?: Record<string, unknown> }
      if (msg.method === undefined) continue
      if (msg.id !== undefined) {
        requests.push({ id: msg.id, method: msg.method })
        handler({ id: msg.id, method: msg.method, params: msg.params ?? {} })
      } else {
        notifs.push({ method: msg.method, params: msg.params ?? {} })
      }
    }
  }
  proc.stdin = stdin
  proc.stdout = stdout
  proc.stderr = stderr
  proc.kill = (): void => {
    stdout.push(null)
    setTimeout(() => proc.emit('close', 0, null), 5)
  }
  ;(proc as unknown as FakeAcp).onRequest = (h): void => {
    const prev = handler
    handler = msg => { prev(msg); h(msg) }
  }
  ;(proc as unknown as FakeAcp).respond = (id, result): void => {
    stdout.push(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
  }
  ;(proc as unknown as FakeAcp).update = (update): void => {
    stdout.push(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'cb-1', update } })}\n`)
  }
  ;(proc as unknown as FakeAcp).close = (code): void => {
    stdout.push(null)
    setTimeout(() => proc.emit('close', code, null), 5)
  }
  ;(proc as unknown as FakeAcp).requestLog = (): string[] => requests.map(r => r.method)
  ;(proc as unknown as FakeAcp).notifications = (): Array<{ method: string; params: Record<string, unknown> }> => notifs
  lastFake = proc as unknown as FakeAcp
  return lastFake
}

const thought = (text: string, messageId = 'm-thought'): Record<string, unknown> => ({
  sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text }, messageId,
})
const message = (text: string, messageId = 'm-msg'): Record<string, unknown> => ({
  sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }, messageId,
})
const toolCall = (id: string, toolName: string, rawInput: Record<string, unknown>, status = 'pending'): Record<string, unknown> => ({
  sessionUpdate: 'tool_call', toolCallId: id, title: `\`${JSON.stringify(rawInput)}\``, kind: 'execute', status,
  rawInput, _meta: { 'codebuddy.ai/toolName': toolName, 'codebuddy.ai/toolArgumentsComplete': status === 'pending' },
})
const toolUpdate = (id: string, status: 'completed' | 'failed', output: string): Record<string, unknown> => ({
  sessionUpdate: 'tool_call_update', toolCallId: id, status, rawOutput: { type: 'text', text: output },
})

/** 常规握手脚本:initialize / session/new / session/load 自动应答。 */
function autoHandshake(f: FakeAcp): void {
  f.onRequest(msg => {
    if (msg.method === 'initialize') f.respond(msg.id, { protocolVersion: 1, agentCapabilities: { loadSession: true } })
    else if (msg.method === 'session/new') f.respond(msg.id, { sessionId: 'cb-1' })
    else if (msg.method === 'session/load') f.respond(msg.id, {})
  })
}

function makeAdapter(timeouts?: Record<string, number>): { adapter: CodebuddyLlmAdapter; appended: string[] } {
  const appended: string[] = []

  const session = {
    // 真实子代理会话:带 lineage header + 调用方(agent-loop)已打开的 step。
    header: { cwd: process.cwd(), parentSession: 'parent-1', origin: 'subagent' as const, delegationDepth: 1 },
    append: (type: string, data: unknown, opts?: unknown) => {
      appended.push(`${type}@${JSON.stringify(data).slice(0, 700)}@opts=${JSON.stringify(opts ?? null)}`)
      return { seq: appended.length }
    },
    ownEvents: (): Array<{ type: string; data: { turn?: number; step?: number } }> => [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'step/start', data: { turn: 1, step: 1 } },
    ],
  }
  const ctx = {
    get: (key: string) => (key === 'sessions' ? { get: () => session } : undefined),
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
  return { adapter, appended }
}

function makeOptions(sessionId: string | undefined, signal?: AbortSignal): GenerateOptions {
  return {
    model: 'glm-5.3',
    provider: 'codebuddy',
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(signal !== undefined ? { signal } : {}),
    messages: [{ role: 'user', content: [{ type: 'text', text: '任务' }] }],
  } as unknown as GenerateOptions
}

beforeEach(() => {
  mockedSpawn.mockReset()
  lastFake = undefined
})

describe('adapter(ACP):基本对话', () => {
  it('thinking 与文本落地为内嵌 stream 的 message(0.1.3 无 chunk 事件),finish stop 收尾', async () => {
    mockedSpawn.mockImplementation(() => {
      const p = fakeAcpProc()
      autoHandshake(p)
      setTimeout(() => {
        p.update(thought('分析中'))
        p.update(message('你好'))
        setTimeout(() => p.respond(p.requestLog().length, { stopReason: 'end_turn' }), 10)
      }, 5)
            return p as unknown as ReturnType<typeof spawn>
    })
    const { adapter, appended } = makeAdapter()
    const chunks: string[] = []
    for await (const chunk of adapter.stream(makeOptions('s1'))) {
      chunks.push(JSON.stringify(chunk))
    }
    expect(appended.some(a => a.startsWith('assistant/chunk'))).toBe(false)
    // 延写一块:'分析中' 在 '你好' 收尾时持久化(surfaceOp append,侧边栏/历史
    // 视图运行中可见);流末的 '你好' 交给循环(其收尾消息=最后一块,非空,
    // 不会再被空消息吞掉;模型派生=两块恰好一次,零重复)。
    const messages = appended.filter(a => a.startsWith('assistant/message'))
    expect(messages.length).toBe(1)
    expect(messages[0]).toContain('分析中')
    expect(messages[0]).toContain('"surfaceOp":"append"')
    expect(chunks.some(c => c.includes('你好'))).toBe(true)
    expect(chunks.some(c => c.includes('分析中'))).toBe(false)
    // adapter 不再自管 step:调用方(agent-loop)打开/关闭 step。
    expect(appended.some(a => a.startsWith('step/'))).toBe(false)
    expect(chunks.some(c => c.includes('"stop"'))).toBe(true)
  }, 15_000)
})

describe('adapter(ACP):会话复用', () => {
  it('同一 dsh 会话第二次调用走 session/load,不再 session/new;load 回放不落地', async () => {
    const { adapter, appended } = makeAdapter()
    let call = 0
    mockedSpawn.mockImplementation(() => {
      call += 1
      const p = fakeAcpProc()
      autoHandshake(p)
      // 真实时序:load 的历史回放在 load 响应 resolve 之前到达
      p.onRequest(msg => {
        if (msg.method === 'session/load') {
          p.update(message('回放内容'))
          p.respond(msg.id, {})
        }
      })
      setTimeout(() => {
        p.update(message('第一轮输出'))
        setTimeout(() => p.respond(p.requestLog().length, { stopReason: 'end_turn' }), 10)
      }, 5)
      return p as unknown as ReturnType<typeof spawn>
    })
    for await (const _ of adapter.stream(makeOptions('s1'))) { /* drain */ }
    for await (const _ of adapter.stream(makeOptions('s1'))) { /* drain */ }
    const f = lastFake!
    expect(f.requestLog()).toContain('session/load')
    expect(f.requestLog()).not.toContain('session/new')
    // 第二次的回放消息('回放内容')不应落地
    expect(appended.filter(a => a.includes('回放内容')).length).toBe(0)
  }, 15_000)
})

describe('adapter(ACP):工具落地', () => {
  it('tool_call/tool_call_update → 会话 tool/call + tool/result,名称来自 _meta,参数来自 rawInput', async () => {
    const { adapter, appended } = makeAdapter()
    mockedSpawn.mockImplementation(() => {
      const p = fakeAcpProc()
      autoHandshake(p)
      setTimeout(() => {
        p.update(thought('跑个命令'))
        p.update(toolCall('call_1', 'Bash', {}, 'in_progress'))
        p.update(toolCall('call_1', 'Bash', { command: 'echo hi' }, 'pending'))
        p.update(toolUpdate('call_1', 'completed', 'Command: echo hi\nStdout: hi'))
        p.update(message('完成了'))
        setTimeout(() => p.respond(p.requestLog().length, { stopReason: 'end_turn' }), 10)
      }, 5)
      return p as unknown as ReturnType<typeof spawn>
    })
    for await (const _ of adapter.stream(makeOptions('s1'))) { /* drain */ }
    expect(appended.filter(a => a.startsWith('tool/call@')).length).toBe(1)
    expect(appended.some(a => a.startsWith('tool/call@') && a.includes('bash') && !a.includes('Bash'))).toBe(true)
    expect(appended.some(a => a.startsWith('tool/call@') && a.includes('echo hi'))).toBe(true)
    expect(appended.some(a => a.startsWith('tool/call@') && a.includes('{}'))).toBe(false)
    // 严格校验:tool/call 前必须有广告(assistant/message 内嵌 tool-call 块,id 一致)。
    const adIndex = appended.findIndex(a => a.startsWith('assistant/message') && a.includes('"type":"tool-call"') && a.includes('call_1'))
    const callIndex = appended.findIndex(a => a.startsWith('tool/call@'))
    expect(adIndex).toBeGreaterThanOrEqual(0)
    expect(adIndex).toBeLessThan(callIndex)
    expect(appended.some(a => a.startsWith('tool/result@') && a.includes('Stdout: hi'))).toBe(true)
    // adapter 只写进调用方打开的 step,绝不写 step 事件。
    expect(appended.some(a => a.startsWith('step/'))).toBe(false)
  }, 15_000)
})

describe('adapter(ACP):取消与错误', () => {
  it('abort → 周期性 session/cancel 通知;prompt 以 cancelled 收尾', async () => {
    const controller = new AbortController()
    mockedSpawn.mockImplementation(() => {
      const p = fakeAcpProc()
      autoHandshake(p)
      p.onRequest(msg => {
        if (msg.method === 'session/prompt') {
          // prompt 挂住,直到收到 cancel 通知后以 cancelled 收尾
          const check = setInterval(() => {
            if (p.notifications().some(n => n.method === 'session/cancel')) {
              clearInterval(check)
              p.respond(msg.id, { stopReason: 'cancelled' })
            }
          }, 100)
        }
      })
      return p as unknown as ReturnType<typeof spawn>
    })
    const { adapter } = makeAdapter()
    const streamPromise = (async (): Promise<string[]> => {
      const out: string[] = []
      for await (const chunk of adapter.stream(makeOptions('s1', controller.signal))) {
        out.push(JSON.stringify(chunk))
      }
      return out
    })()
    setTimeout(() => controller.abort(), 1500)
    const chunks = await streamPromise
    expect(lastFake!.notifications().filter(n => n.method === 'session/cancel').length).toBeGreaterThanOrEqual(1)
    // abort 语义:流直接结束(不产 finish,调用方主动取消)。
    expect(chunks.some(c => c.includes('error'))).toBe(false)
  }, 15_000)

  it('进程中途异常退出 → 抛错并附退出码', async () => {
    mockedSpawn.mockImplementation(() => {
      const p = fakeAcpProc()
      autoHandshake(p)
      setTimeout(() => { p.update(thought('开始')); p.close(1) }, 10)
      return p as unknown as ReturnType<typeof spawn>
    })
    const { adapter } = makeAdapter()
    const chunks: string[] = []
    for await (const chunk of adapter.stream(makeOptions('s1'))) chunks.push(JSON.stringify(chunk))
    expect(chunks.some(c => c.includes('CODEBUDDY_EXEC_ERROR') && (c.includes('退出') || c.includes('exit')))).toBe(true)
  }, 15_000)

  it('静默无进展 → 先 cancel 后 kill,抛出明确超时错误', async () => {
    const { adapter } = makeAdapter({ firstMs: 100, idleMaxMs: 200, idleMinMs: 100, idleFactor: 2, idleWarmupLines: 0, maxAttempts: 1, retryDelayMs: 10 })
    mockedSpawn.mockImplementation(() => {
      const p = fakeAcpProc()
      autoHandshake(p)
      // prompt 永不响应、永不推 update(纯死挂)
      return p as unknown as ReturnType<typeof spawn>
    })
    const chunks: string[] = []
    for await (const chunk of adapter.stream(makeOptions('s1'))) chunks.push(JSON.stringify(chunk))
    expect(chunks.some(c => c.includes('CODEBUDDY_EXEC_ERROR') && c.includes('超时'))).toBe(true)
    expect(lastFake!.notifications().filter(n => n.method === 'session/cancel').length).toBeGreaterThanOrEqual(1)
  }, 25_000)

  it('默认预算与统一算法一致', () => {
    expect(DEFAULT_ACP_RUN_TIMEOUTS).toEqual({
      firstMs: 60_000,
      idleMinMs: 150_000,
      idleMaxMs: 600_000,
      idleFactor: 3,
      idleWarmupLines: 6,
      // 尾巴窗口:普通回合静默 5s 收尾;起了后台任务放宽到 10 分钟;硬顶 30 分钟。
      tailQuietMs: 5_000,
      tailBgQuietMs: 10 * 60_000,
      tailCapMs: 30 * 60_000,
    })
  })
})

describe('usageOfUpdate:usage_update → dsh TokenUsage', () => {
  it('OpenAI 风格字段映射为三个不重叠桶;命中优先 hit 字段(cache_read_input_tokens 恒 0)', () => {
    const usage = usageOfUpdate({
      sessionUpdate: 'usage_update',
      _meta: {
        usage: {
          prompt_tokens: 25414,
          completion_tokens: 24,
          total_tokens: 25438,
          prompt_cache_hit_tokens: 25216,
          prompt_cache_miss_tokens: 198,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          completion_tokens_details: { reasoning_tokens: 22 },
        },
      },
    })
    expect(usage).toEqual({
      inputTokens: 198,
      outputTokens: 24,
      totalTokens: 25438,
      cacheReadTokens: 25216,
      cacheWriteTokens: 0,
      reasoningTokens: 22,
    })
  })

  it('缺 miss 字段时由 prompt − hit 推导;空载心跳(全零)不产生用量', () => {
    const derived = usageOfUpdate({
      sessionUpdate: 'usage_update',
      _meta: { usage: { prompt_tokens: 1000, completion_tokens: 5, prompt_cache_hit_tokens: 800 } },
    })
    expect(derived).toMatchObject({ inputTokens: 200, outputTokens: 5, cacheReadTokens: 800 })
    expect(usageOfUpdate({ sessionUpdate: 'usage_update', _meta: { usage: { prompt_tokens: 0, completion_tokens: 0 } } })).toBeUndefined()
    expect(usageOfUpdate({ sessionUpdate: 'usage_update' })).toBeUndefined()
  })
})
