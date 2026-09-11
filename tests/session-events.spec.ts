/**
 * chunk 流契约(泵 → agent-loop 组装)。
 *
 * 路线 C1 下,插件不再写会话事件:每个 dsh step 的 `assistant/message`、
 * `tool/call`、`tool/result` 都由 agent-loop 用**本文件校验的 chunk 流**组装
 * 后原生写入(生产环境由会话关系校验器在 append 时把关)。因此插件的护栏是:
 * 每个 step 的 chunk 能被 `BlockAssembler` 无损组装成合法的内容块——
 * 块配对完整、工具调用的 id/name/arguments 一次且完整、顺序与 ACP 一致;
 * 并且每个工具调用都有对应的回放工具可执行。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import { CodebuddyLlmAdapter } from '../src/adapter.ts'
import { ConversationStore } from '../src/conversations.ts'
import { TurnPump, resetPumpStateForTests } from '../src/pump.ts'
import { asSpawnResult, autoHandshake, fakeAcpProc, message, phase, thought, toolCall, toolUpdate } from './fake-acp.ts'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn() }
})
const { spawn } = await import('node:child_process')
const mockedSpawn = vi.mocked(spawn)

const FAST = {
  firstMs: 2_000,
  idleMinMs: 5_000,
  idleMaxMs: 5_000,
  idleWarmupLines: 6,
  tailQuietMs: 60,
  tailBgQuietMs: 240,
  tailCapMs: 800,
  boundaryQuietMs: 20,
  usageGraceMs: 20,
}

interface Harness {
  adapter: CodebuddyLlmAdapter
  registeredTools: Map<string, Record<string, unknown>>
}

function makeAdapter(): Harness {
  const registeredTools = new Map<string, Record<string, unknown>>()
  const session = {
    header: { cwd: process.cwd(), parentSession: 'p1', origin: 'subagent' },
    append: () => ({ seq: 0 }),
    ownEvents: () => [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'step/start', data: { turn: 1, step: 1 } },
    ],
  }
  const toolsFace = {
    register: (definition: Record<string, unknown>): (() => void) => {
      registeredTools.set(String(definition['name']), definition)
      return () => {}
    },
  }
  const ctx = {
    get: (key: string) => {
      if (key === 'sessions') return { get: () => session }
      if (key === 'agents') return { get: (id: string) => (id === 's1' ? { ctx: { get: (k: string) => (k === 'tools' ? toolsFace : undefined) } } : undefined) }
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
    steerPollMs: 20,
    timeouts: FAST,
  })
  return { adapter, registeredTools }
}

function options(): GenerateOptions {
  return {
    model: 'glm-5.3',
    provider: 'codebuddy',
    sessionId: 's1',
    messages: [{ role: 'user', content: [{ type: 'text', text: '任务' }] }],
  } as unknown as GenerateOptions
}

/** 一个 step 的原始 chunk(供 assembler 组装)。 */
async function stepChunks(adapter: CodebuddyLlmAdapter): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream(options())) chunks.push(chunk)
  return chunks
}

/** 组装一个 step 的内容块。 */
function assemble(chunks: readonly StreamChunk[]): ReturnType<BlockAssembler['blocks']> {
  const assembler = new BlockAssembler()
  for (const chunk of chunks) assembler.push(chunk)
  return assembler.blocks()
}

beforeEach(() => {
  mockedSpawn.mockReset()
  resetPumpStateForTests()
})

describe('chunk 流契约:一个回合的多个 step 都能被无损组装', () => {
  it('两个工具调用(成功+失败)+ 交错文本:块配对完整、工具调用一次且完整', async () => {
    mockedSpawn.mockImplementation(() => {
      const p = fakeAcpProc()
      autoHandshake(p)
      setTimeout(() => {
        p.update(thought('先想'))
        p.update(message('开始处理'))
        p.update(toolCall('call_a', 'Bash', { command: 'echo a' }))
        p.update(phase('tool_executing'))
        p.update(toolUpdate('call_a', 'completed', 'a'))
        setTimeout(() => {
          p.update(message('继续'))
          p.update(toolCall('call_b', 'Read', { path: 'x.txt' }))
          p.update(phase('tool_executing'))
          p.update(toolUpdate('call_b', 'failed', 'boom'))
          setTimeout(() => {
            p.update(message('收尾文本'))
            p.update(phase('idle'))
            p.respond(p.requestLog().length, { stopReason: 'end_turn' })
          }, 60)
        }, 60)
      }, 5)
      return asSpawnResult(p)
    })
    const { adapter, registeredTools } = makeAdapter()

    const first = await stepChunks(adapter)
    // 组装不抛错(未知块类型未闭合会 throw),且第一段有思考/文本/工具块。
    const blocks1 = assemble(first)
    const kinds1 = blocks1.map(block => block.type)
    expect(kinds1).toEqual(expect.arrayContaining(['reasoning', 'text', 'tool-call']))
    // 文本块在前、工具块在后(与 ACP 到达顺序一致)。
    expect(kinds1.indexOf('text')).toBeLessThan(kinds1.indexOf('tool-call'))
    // 工具名归一化、参数完整、id 与回放工具一一对应(趁泵还在,结果可取)。
    const callA = blocks1.find(block => block.type === 'tool-call')
    expect(callA).toBeDefined()
    expect(callA && callA.type === 'tool-call' ? callA.name : '').toBe('bash')
    expect(registeredTools.has('bash')).toBe(true)
    const resultA = await (registeredTools.get('bash')!['execute'] as (args: unknown, exec: unknown) => Promise<unknown>)(
      {}, { callId: callA && callA.type === 'tool-call' ? callA.id : '' },
    )
    expect(JSON.stringify(resultA)).toContain('a')

    const second = await stepChunks(adapter)
    const callB = assemble(second).find(block => block.type === 'tool-call')
    expect(callB).toBeDefined()
    expect(callB && callB.type === 'tool-call' ? callB.name : '').toBe('read')
    const toolB = registeredTools.get('read')!
    await expect((toolB['execute'] as (args: unknown, exec: unknown) => Promise<unknown>)(
      {}, { callId: callB && callB.type === 'tool-call' ? callB.id : '' },
    )).rejects.toThrow('boom')

    const third = await stepChunks(adapter)
    expect(assemble(third).map(block => block.type)).toContain('text')
    // 收尾段以 finish 结束;回合收尾后泵已释放。
    expect(third.some(chunk => chunk.type === 'finish')).toBe(true)
    expect(TurnPump.forSession('s1')).toBeUndefined()
  }, 15_000)

  it('abort 中途挂起工具:已交付的块仍可组装,悬空工具由回放工具拒绝', async () => {
    const controller = new AbortController()
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
        p.update(message('开始'))
        p.update(toolCall('call_x', 'Bash', { command: 'sleep 1' }))
        p.update(phase('tool_executing'))
      }, 20)
      return asSpawnResult(p)
    })
    const { adapter, registeredTools } = makeAdapter()
    const run = (async (): Promise<StreamChunk[]> => {
      const chunks: StreamChunk[] = []
      for await (const chunk of adapter.stream({ ...options(), signal: controller.signal } as GenerateOptions)) {
        chunks.push(chunk)
      }
      return chunks
    })()
    setTimeout(() => controller.abort(), 300)
    const chunks = await run

    const blocks = assemble(chunks)
    expect(blocks.map(block => block.type)).toEqual(expect.arrayContaining(['text', 'tool-call']))
    const call = blocks.find(block => block.type === 'tool-call')
    expect(call).toBeDefined()
    // 结果永不到:回放工具被拒(不悬挂)。
    const tool = registeredTools.get('bash')!
    await expect((tool['execute'] as (args: unknown, exec: unknown) => Promise<unknown>)({}, { callId: 'call_x' }))
      .rejects.toThrow()
  }, 15_000)
})
