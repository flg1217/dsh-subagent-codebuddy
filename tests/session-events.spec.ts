/**
 * 最强护栏:把 adapter 一轮真实写入的事件序列交给官方关系校验器
 * (`assertReleasedArtifactRelationships`,v1→v2 迁移路径用的同一份校验),
 * 确保产物满足严格 v2 会话格式——包括 tool/call 必须被前置 assistant/message
 * 广告、step/end 无未决工具、adapter 不写 step 事件。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { assertReleasedArtifactRelationships } from '@deepseek-ai/dsh-session-format-v0-to-v1'
import { asSpawnResult, autoHandshake, fakeAcpProc, message, thought, toolCall, toolUpdate } from './fake-acp.ts'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn() }
})
const { spawn } = await import('node:child_process')
const mockedSpawn = vi.mocked(spawn)

import { makeRecordingAdapter } from './recording-fixture.ts'
import type { RecordedEvent } from './recording-fixture.ts'


function options(): GenerateOptions {
  return {
    model: 'glm-5.3',
    provider: 'codebuddy',
    sessionId: 's1',
    messages: [{ role: 'user', content: [{ type: 'text', text: '任务' }] }],
  } as unknown as GenerateOptions
}

beforeEach(() => {
  mockedSpawn.mockReset()
})

describe('adapter 产物 vs 官方关系校验', () => {
  it('一轮含两个工具调用(成功+失败)+ 交错文本:通过 assertReleasedArtifactRelationships', async () => {
    mockedSpawn.mockImplementation(() => {
      const p = fakeAcpProc()
      autoHandshake(p)
      setTimeout(() => {
        p.update(thought('先想'))
        p.update(message('开始处理'))
        p.update(toolCall('call_a', 'Bash', { command: 'echo a' }))
        p.update(toolUpdate('call_a', 'completed', 'a'))
        p.update(message('继续'))
        p.update(toolCall('call_b', 'Read', { path: 'x.txt' }))
        p.update(toolUpdate('call_b', 'failed', 'boom'))
        p.update(message('收尾文本'))
        p.respond(p.requestLog().length, { stopReason: 'end_turn' })
      }, 5)
      return asSpawnResult(p)
    })
    const { adapter, events, seedTurnEnd } = makeRecordingAdapter()
    for await (const _ of adapter.stream(options())) { /* drain */ }
    seedTurnEnd()

    // 结构前置断言(与校验器互补,失败时定位更快)。
    expect(events.some(e => e.type === 'step/start' && e.seq > 2)).toBe(false)
    expect(events.filter(e => e.type === 'tool/call').length).toBe(2)
    expect(events.filter(e => e.type === 'tool/result').length).toBe(2)

    const artifact = {
      header: { version: 2 },
      inheritedEventCount: 0,
      events,
    }
    expect(() => assertReleasedArtifactRelationships(
      artifact as unknown as Parameters<typeof assertReleasedArtifactRelationships>[0],
      { stepEvents: new Set(['assistant/attempt']) },
    )).not.toThrow()
  }, 15_000)

  it('abort 中途挂起工具:收尾后的序列同样通过校验', async () => {
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
      }, 20)
      return asSpawnResult(p)
    })
    const { adapter, events, seedTurnEnd } = makeRecordingAdapter()
    const run = (async (): Promise<void> => {
      for await (const _ of adapter.stream({
        ...options(),
        signal: controller.signal,
      } as unknown as GenerateOptions)) { /* drain */ }
    })()
    setTimeout(() => controller.abort(), 300)
    await run
    seedTurnEnd()

    const result = events.find(e => e.type === 'tool/result')
    expect(result).toBeDefined()
    expect(JSON.stringify(result!.data)).toContain('"isError":true')

    const artifact = {
      header: { version: 2 },
      inheritedEventCount: 0,
      events,
    }
    expect(() => assertReleasedArtifactRelationships(
      artifact as unknown as Parameters<typeof assertReleasedArtifactRelationships>[0],
      { stepEvents: new Set(['assistant/attempt']) },
    )).not.toThrow()
  }, 15_000)
})
