/**
 * 续聊补发与跨重启恢复测试:
 * - 首轮全量、次轮只补发锚点之后的消息(跳过 CodeBuddy 自己产生的消息);
 * - 切换其他模型期间缺失的轮次被完整补发;
 * - 服务重启(新 adapter + 同一持久化 store)从 CodeBuddy 持久会话恢复(session/load);
 * - 锚点缺失/会话存储丢失的兜底路径。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { CodebuddyLlmAdapter } from '../src/adapter.ts'
import { ConversationStore } from '../src/conversations.ts'
import { projectSlug } from '../src/native-session.ts'
import { asSpawnResult, fakeAcpProc, message } from './fake-acp.ts'
import { DSH_DELEGATION_NOTE } from '../src/pump.ts'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn() }
})
const { spawn } = await import('node:child_process')
const mockedSpawn = vi.mocked(spawn)

/** 一条简单消息。 */
function msg(id: string, role: 'user' | 'assistant', text: string, source?: Record<string, unknown>): Message {
  return {
    id,
    role,
    content: [{ type: 'text', text }],
    source: source ?? (role === 'assistant' ? { kind: 'model', provider: 'codebuddy', model: 'glm-5.3' } : { kind: 'user' }),
  } as unknown as Message
}

function toolResult(id: string, callId: string, text: string): Message {
  return {
    id,
    role: 'user',
    content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }] }],
    source: { kind: 'tool', callId },
  } as unknown as Message
}

interface Harness {
  adapter: CodebuddyLlmAdapter
  prompts: string[]
  requests: () => string[]
}

function makeHarness(
  store: ConversationStore,
  sessionId = 's1',
  failLoad = false,
  nativeBaseDir?: string,
): Harness {
  const prompts: string[] = []
  const session = {
    header: { cwd: process.cwd(), parentSession: 'p1', origin: 'subagent' },
    append: () => ({ seq: 0 }),
    ownEvents: () => [
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
    store,
    ...(nativeBaseDir !== undefined ? { nativeBaseDir } : {}),
  })
  mockedSpawn.mockImplementation(() => {
    const p = fakeAcpProc()
    p.onRequest(request => {
      if (request.method === 'initialize') {
        p.respond(request.id, { protocolVersion: 1, agentCapabilities: { loadSession: true } })
      } else if (request.method === 'session/new') {
        p.respond(request.id, { sessionId: 'cb-1' })
      } else if (request.method === 'session/load') {
        if (failLoad) p.respondError(request.id, { code: -1, message: 'session not found' })
        else p.respond(request.id, {})
      } else if (request.method === 'session/prompt') {
        const prompt = (request.params['prompt'] as Array<{ text: string }>)[0]
        prompts.push(prompt?.text ?? '')
        setTimeout(() => p.respond(request.id, { stopReason: 'end_turn' }), 5)
      }
    })
    setTimeout(() => { p.update(message('回复')) }, 5)
    return asSpawnResult(p)
  })
  return { adapter, prompts, requests: () => fakeAcpProcCalls() }
}

/** 最近一次假进程的请求记录。 */
function fakeAcpProcCalls(): string[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const last = (vi.mocked(spawn).mock.results.at(-1)?.value as any)
  return last?.requestLog?.() ?? []
}

function options(messages: Message[]): GenerateOptions {
  return {
    model: 'glm-5.3',
    provider: 'codebuddy',
    sessionId: 's1',
    messages,
  } as unknown as GenerateOptions
}

async function drain(adapter: CodebuddyLlmAdapter, opts: GenerateOptions): Promise<void> {
  for await (const _ of adapter.stream(opts)) { /* drain */ }
}

beforeEach(() => {
  mockedSpawn.mockReset()
})

describe('续聊补发', () => {
  it('首轮全量;次轮只补发新轮次(跳过 CodeBuddy 自己的回复)', async () => {
    const store = new ConversationStore(null)
    const { adapter, prompts } = makeHarness(store)
    const u1 = msg('u1', 'user', '第一问')
    await drain(adapter, options([u1]))
    expect(prompts[0]).toContain('第一问')

    const u2 = msg('u2', 'user', '第二问')
    await drain(adapter, options([u1, msg('a1', 'assistant', '第一答'), u2]))
    expect(prompts[1]).toContain('第二问')
    expect(prompts[1]).not.toContain('第一问')
    expect(prompts[1]).not.toContain('第一答')
  })

  it('切换其他模型后的缺失轮次被完整补发', async () => {
    const store = new ConversationStore(null)
    const { adapter, prompts } = makeHarness(store)
    const u1 = msg('u1', 'user', '第一问')
    await drain(adapter, options([u1]))

    // 期间:CodeBuddy 回 a1;切到其他模型跑了一轮(u2/a2/工具结果);回到 CodeBuddy(u3)。
    const messages = [
      u1,
      msg('a1', 'assistant', 'CodeBuddy 的第一答'),
      msg('u2', 'user', '其他模型的问题'),
      msg('a2', 'assistant', '其他模型的回答', { kind: 'model', provider: 'cpa', model: 'kimi-k3' }),
      toolResult('t1', 'call_x', '工具输出内容'),
      msg('u3', 'user', '回到 CodeBuddy 的问题'),
    ]
    await drain(adapter, options(messages))
    const prompt = prompts.at(-1)!
    expect(prompt).toContain('其他模型的问题')
    expect(prompt).toContain('其他模型的回答')
    expect(prompt).toContain('工具输出内容')
    expect(prompt).toContain('回到 CodeBuddy 的问题')
    expect(prompt).not.toContain('第一问')
    expect(prompt).not.toContain('CodeBuddy 的第一答')
  })
})

describe('原生会话种子(已有历史切换)', () => {
  it('写原生会话文件 + session/load,prompt 只带当前输入', async () => {
    const store = new ConversationStore(null)
    const baseDir = mkdtempSync(join(tmpdir(), 'cb-native-'))
    try {
      const { adapter, prompts, requests } = makeHarness(store, 's1', false, baseDir)
      await drain(adapter, options([
        msg('u1', 'user', '历史问题一'),
        msg('a1', 'assistant', '历史回答一'),
        msg('u2', 'user', '当前问题'),
      ]))
      expect(requests()).toContain('session/load')
      expect(requests()).not.toContain('session/new')
      // prompt 只带当前输入,历史不在提示词里。
      expect(prompts.at(-1)?.startsWith('当前问题')).toBe(true)
      expect(prompts.at(-1)?.endsWith(DSH_DELEGATION_NOTE)).toBe(true)
      // 原生文件已写入:含历史消息,不含当前输入(它作为 prompt 发送)。
      const dir = join(baseDir, projectSlug(process.cwd()))
      const files = readdirSync(dir).filter(f => f.endsWith('.jsonl'))
      expect(files.length).toBe(1)
      const content = readFileSync(join(dir, files[0]!), 'utf8')
      expect(content).toContain('历史问题一')
      expect(content).toContain('历史回答一')
      expect(content).not.toContain('当前问题')
    } finally {
      rmSync(baseDir, { recursive: true, force: true })
    }
  })

  it('原生载入被拒 → 回退新会话 + 全量提示词', async () => {
    const store = new ConversationStore(null)
    const baseDir = mkdtempSync(join(tmpdir(), 'cb-native-'))
    try {
      const { adapter, prompts, requests } = makeHarness(store, 's1', true, baseDir)
      await drain(adapter, options([
        msg('u1', 'user', '历史问题一'),
        msg('a1', 'assistant', '历史回答一'),
        msg('u2', 'user', '当前问题'),
      ]))
      expect(requests()).toContain('session/load')
      expect(requests()).toContain('session/new')
      const prompt = prompts.at(-1)!
      expect(prompt).toContain('历史问题一')
      expect(prompt).toContain('当前问题')
    } finally {
      rmSync(baseDir, { recursive: true, force: true })
    }
  })

  it('单条消息的新会话不开原生种子(子代理首派发走 session/new)', async () => {
    const store = new ConversationStore(null)
    const baseDir = mkdtempSync(join(tmpdir(), 'cb-native-'))
    try {
      const { adapter, prompts, requests } = makeHarness(store, 's1', false, baseDir)
      await drain(adapter, options([msg('u1', 'user', '任务描述')]))
      expect(requests()).toContain('session/new')
      expect(requests()).not.toContain('session/load')
      expect(prompts.at(-1)).toContain('任务描述')
    } finally {
      rmSync(baseDir, { recursive: true, force: true })
    }
  })
})

describe('跨重启恢复', () => {
  it('重启后(新 adapter + 持久化 store)走 session/load,不再 session/new', async () => {
    const store = new ConversationStore(null)
    const first = makeHarness(store)
    await drain(first.adapter, options([msg('u1', 'user', '问题一')]))
    expect(first.requests()).toContain('session/new')

    // “重启”:同一个持久化 store 构造新 adapter。
    const second = makeHarness(store)
    await drain(second.adapter, options([msg('u1', 'user', '问题一'), msg('a1', 'assistant', '答一'), msg('u2', 'user', '问题二')]))
    expect(second.requests()).toContain('session/load')
    expect(second.requests()).not.toContain('session/new')
  })

  it('CodeBuddy 侧会话丢失:回退新会话 + 完整历史重发', async () => {
    const store = new ConversationStore(null)
    const first = makeHarness(store)
    await drain(first.adapter, options([msg('u1', 'user', '问题一')]))

    const second = makeHarness(store, 's1', true) // load 失败
    await drain(second.adapter, options([msg('u1', 'user', '问题一'), msg('a1', 'assistant', '答一'), msg('u2', 'user', '问题二')]))
    expect(second.requests()).toContain('session/load')
    expect(second.requests()).toContain('session/new')
    const prompt = second.prompts.at(-1)!
    expect(prompt).toContain('问题一')
    expect(prompt).toContain('问题二')
  })

  it('锚点被压缩移除(历史收缩)时整体重建 surface,不再只发最后一条', async () => {
    const store = new ConversationStore(null)
    const { adapter, prompts } = makeHarness(store)
    await drain(adapter, options([msg('u1', 'user', '很长的问题一'), msg('a1', 'assistant', '答一'), msg('u2', 'user', '问题二')]))
    // 下一次:历史被压缩收缩(锚点消息已被移除)→ 当前 surface 整体重建。
    await drain(adapter, options([msg('u3', 'user', '压缩后的新问题')]))
    const prompt = prompts.at(-1)!
    // 重建走 serializeMessages:带 `User: ` 标签,而不是只发最后一条裸文本。
    expect(prompt).toContain('压缩后的新问题')
    expect(prompt).toContain('User: 压缩后的新问题')
    expect(prompt.endsWith(DSH_DELEGATION_NOTE)).toBe(true)
  })
})
