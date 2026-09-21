/**
 * 中断原因端到端:CLI 的失败上报(refusal + _meta errorMessage / JSON-RPC error)
 * 经分类后,finish error 必须带可读原因;配额/认证不重试,瞬时故障保持续跑。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { spawn } from 'node:child_process'
import { asSpawnResult, autoHandshake, fakeAcpProc, message } from './fake-acp.ts'
import { makeRecordingAdapter } from './recording-fixture.ts'
import type { RecordedEvent } from './recording-fixture.ts'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn() }
})
const mockedSpawn = vi.mocked(spawn)

beforeEach(() => {
  mockedSpawn.mockReset()
})

const QUOTA_JSON = JSON.stringify({
  code: -32003,
  message: 'Quota exceeded: too many requests',
  data: { category: 'quota', subcategory: 'quota_request_limit', statusCode: 429, code: 14003 },
})
const MODEL_SERVICE_JSON = JSON.stringify({
  code: -32004,
  message: 'Model service error: overloaded',
  data: { category: 'model_service', statusCode: 503 },
})

interface FinishChunk {
  type: string
  reason?: { kind?: string; failure?: { message?: string; code?: string } }
}

async function drainFail(adapter: ReturnType<typeof makeRecordingAdapter>['adapter'], sessionId: string): Promise<FinishChunk[]> {
  const chunks: FinishChunk[] = []
  for await (const chunk of adapter.stream({
    model: 'glm-5.3',
    provider: 'codebuddy',
    sessionId,
    messages: [{ role: 'user', content: [{ type: 'text', text: '任务' }] }],
  } as never)) {
    chunks.push(chunk as never)
  }
  return chunks
}

describe('adapter(ACP):失败原因透出', () => {
  it('配额限流(refusal + _meta errorMessage)→ 不重试,finish error 显示限流原因与证据', async () => {
    mockedSpawn.mockImplementation(() => {
      const p = fakeAcpProc()
      autoHandshake(p)
      p.onRequest(msg => {
        if (msg.method === 'session/prompt') {
          setTimeout(() => {
            p.respond(msg.id, {
              stopReason: 'refusal',
              _meta: { 'codebuddy.ai/errorMessage': QUOTA_JSON, 'codebuddy.ai/traceId': 't-1' },
            })
          }, 5)
        }
      })
      return asSpawnResult(p)
    })
    const { adapter } = makeRecordingAdapter({ maxAttempts: 2, retryDelayMs: 10 })
    const chunks = await drainFail(adapter, 's-quota')
    const finish = chunks.at(-1)
    expect(finish?.type).toBe('finish')
    expect(finish?.reason?.kind).toBe('error')
    const message = finish?.reason?.failure?.message ?? ''
    expect(message).toContain('限流')
    expect(message).toContain('category=quota')
    expect(message).toContain('httpStatus=429')
    expect(message).toContain('bizCode=14003')
    // 配额失败重试无意义:只发一次 prompt。
    expect(mockedSpawn).toHaveBeenCalledTimes(1)
  }, 15_000)

  it('模型服务异常 → 自动续跑重试,用尽后仍显示分类原因', async () => {
    mockedSpawn.mockImplementation(() => {
      const p = fakeAcpProc()
      autoHandshake(p)
      p.onRequest(msg => {
        if (msg.method === 'session/prompt') {
          setTimeout(() => {
            p.respond(msg.id, {
              stopReason: 'refusal',
              _meta: { 'codebuddy.ai/errorMessage': MODEL_SERVICE_JSON },
            })
          }, 5)
        }
      })
      return asSpawnResult(p)
    })
    const { adapter } = makeRecordingAdapter({ maxAttempts: 2, retryDelayMs: 10 })
    const chunks = await drainFail(adapter, 's-svc')
    expect(mockedSpawn).toHaveBeenCalledTimes(2)
    const message = chunks.at(-1)?.reason?.failure?.message ?? ''
    expect(message).toContain('模型服务异常')
    expect(message).toContain('category=model_service')
  }, 15_000)

  it('JSON-RPC error(data 带分类)→ 同样翻译成限流原因,不重试', async () => {    mockedSpawn.mockImplementation(() => {
      const p = fakeAcpProc()
      autoHandshake(p)
      p.onRequest(msg => {
        if (msg.method === 'session/prompt') {
          setTimeout(() => {
            p.respondError(msg.id, {
              code: -32003,
              message: 'Quota exceeded: too many requests',
              data: { category: 'quota', subcategory: 'quota_request_limit', statusCode: 429, code: 14003 },
            })
          }, 5)
        }
      })
      return asSpawnResult(p)
    })
    const { adapter } = makeRecordingAdapter({ maxAttempts: 2, retryDelayMs: 10 })
    const chunks = await drainFail(adapter, 's-rpc')
    const message = chunks.at(-1)?.reason?.failure?.message ?? ''
    expect(chunks.at(-1)?.reason?.kind).toBe('error')
    expect(message).toContain('限流')
    expect(mockedSpawn).toHaveBeenCalledTimes(1)
  }, 15_000)

  it('正常完成(_meta 带 outcome=SUCCESS)→ 不误报中断,finish stop', async () => {
    mockedSpawn.mockImplementation(() => {
      const p = fakeAcpProc()
      autoHandshake(p)
      p.onRequest(msg => {
        if (msg.method === 'session/prompt') {
          setTimeout(() => {
            p.update({
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: '完成' },
              messageId: 'm-ok',
            })
            p.respond(msg.id, { stopReason: 'end_turn', _meta: { 'codebuddy.ai/outcome': 'SUCCESS' } })
          }, 5)
        }
      })
      return asSpawnResult(p)
    })
    const { adapter } = makeRecordingAdapter({ maxAttempts: 2, retryDelayMs: 10 })
    const chunks = await drainFail(adapter, 's-ok')
    expect(chunks.at(-1)?.reason?.kind).toBe('stop')
    expect(mockedSpawn).toHaveBeenCalledTimes(1)
  }, 15_000)
})

/** 从记录的事件里取 assistant/message 的纯文本(只可能是插件补写的)。 */
function closingTexts(events: readonly RecordedEvent[]): string[] {
  return events
    .filter(event => event.type === 'assistant/message')
    .map((event) => {
      const blocks = (event.data as { message?: { content?: readonly { type: string; text?: string }[] } })
        .message?.content ?? []
      return blocks.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
    })
}

describe('子代理失败的临终遗言(失败原因必须回到主代理)', () => {
  it('零产出失败 → 补一条带原因的 assistant/message', async () => {
    // 事故(2026-09-21 用户报障):子代理 401 失败,主代理只收到
    // "Background subagent X failed before it finished. / It left no closing
    // message." —— dsh 的结算通知只带通用结论 + 子代理最后一条 assistant 消息,
    // 而硬失败时 agent-loop 直接 throw、不产生 assistant 消息,原因整条丢失。
    // 补写这条后 AssistantOutputFold 会选中它,原因随通知回主代理。
    mockedSpawn.mockImplementation(() => {
      const p = fakeAcpProc()
      autoHandshake(p)
      p.onRequest(msg => {
        if (msg.method === 'session/prompt') {
          setTimeout(() => {
            p.respond(msg.id, {
              stopReason: 'refusal',
              _meta: { 'codebuddy.ai/errorMessage': QUOTA_JSON, 'codebuddy.ai/traceId': 't-2' },
            })
          }, 5)
        }
      })
      return asSpawnResult(p)
    })
    const { adapter, events } = makeRecordingAdapter({ maxAttempts: 1, retryDelayMs: 10 })
    const chunks = await drainFail(adapter, 's-child-fail')
    expect(chunks.at(-1)?.reason?.kind).toBe('error')
    const texts = closingTexts(events)
    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain('CodeBuddy 回合失败')
    expect(texts[0]).toContain('category=quota')
  }, 15_000)

  it('主会话失败 → 不补(UI 已有"本轮运行失败"卡,补写只会污染转录)', async () => {
    mockedSpawn.mockImplementation(() => {
      const p = fakeAcpProc()
      autoHandshake(p)
      p.onRequest(msg => {
        if (msg.method === 'session/prompt') {
          setTimeout(() => {
            p.respond(msg.id, {
              stopReason: 'refusal',
              _meta: { 'codebuddy.ai/errorMessage': QUOTA_JSON },
            })
          }, 5)
        }
      })
      return asSpawnResult(p)
    })
    const { adapter, events } = makeRecordingAdapter({ maxAttempts: 1, retryDelayMs: 10, mainSession: true })
    const chunks = await drainFail(adapter, 's-main-fail')
    expect(chunks.at(-1)?.reason?.kind).toBe('error')
    expect(closingTexts(events)).toHaveLength(0)
  }, 15_000)

  it('失败前已有文本 → 不补(agent-loop 的 assistant/attempt 流文本才是临终遗言)', async () => {
    // AssistantOutputFold 优先选 assistant/message;此时补写会把真实的
    // 半截产出顶掉,通知里只剩失败原因、丢掉子代理已经干出来的活。
    mockedSpawn.mockImplementation(() => {
      const p = fakeAcpProc()
      autoHandshake(p)
      p.onRequest(msg => {
        if (msg.method === 'session/prompt') {
          setTimeout(() => p.update(message('正在处理')), 5)
          setTimeout(() => {
            p.respond(msg.id, {
              stopReason: 'refusal',
              _meta: { 'codebuddy.ai/errorMessage': QUOTA_JSON },
            })
          }, 30)
        }
      })
      return asSpawnResult(p)
    })
    const { adapter, events } = makeRecordingAdapter({ maxAttempts: 1, retryDelayMs: 10 })
    const chunks = await drainFail(adapter, 's-child-partial')
    expect(chunks.at(-1)?.reason?.kind).toBe('error')
    expect(closingTexts(events)).toHaveLength(0)
  }, 15_000)
})
