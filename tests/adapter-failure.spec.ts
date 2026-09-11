/**
 * 中断原因端到端:CLI 的失败上报(refusal + _meta errorMessage / JSON-RPC error)
 * 经分类后,finish error 必须带可读原因;配额/认证不重试,瞬时故障保持续跑。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { spawn } from 'node:child_process'
import { asSpawnResult, autoHandshake, fakeAcpProc } from './fake-acp.ts'
import { makeRecordingAdapter } from './recording-fixture.ts'

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
