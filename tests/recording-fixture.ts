/**
 * 记录型会话 fixture:预置调用方(agent-loop)打开的 turn/step,
 * adapter 写入追加其后;结束后由测试补 step/end + turn/end。
 * 供 session-events / image-result 等规格共用。
 */
import type { Context } from '@deepseek-ai/cordis'
import { CodebuddyLlmAdapter } from '../src/adapter.ts'
import { ConversationStore } from '../src/conversations.ts'

export interface RecordedEvent {
  type: string
  seq: number
  time: number
  data: unknown
  surfaceOp?: unknown
  sourceEventSeqs?: readonly number[]
}

export function makeRecordingAdapter(opts?: {
  attachments?: { saveImage: (input: { data: Uint8Array; mediaType: string }) => Promise<unknown> }
  /** 静默失败重试次数(默认 2;错误路径测试传 1 防真实重试)。 */
  maxAttempts?: number
  /** 重试间隔毫秒(默认 3s;测试传小值)。 */
  retryDelayMs?: number
}): {
  adapter: CodebuddyLlmAdapter
  events: RecordedEvent[]
  seedTurnEnd: () => void
} {
  const events: RecordedEvent[] = []
  const record = (type: string, data: unknown, opts?: { surfaceOp?: unknown; sourceEventSeqs?: readonly number[] }): void => {
    events.push({
      type,
      seq: events.length,
      time: events.length + 1,
      data,
      ...(opts?.surfaceOp !== undefined ? { surfaceOp: opts.surfaceOp } : {}),
      ...(opts?.sourceEventSeqs !== undefined ? { sourceEventSeqs: opts.sourceEventSeqs } : {}),
    })
  }
  // 调用方的已提交事件(turn/step 由其打开)。
  record('turn/start', { turn: 1 })
  record('step/start', { turn: 1, step: 1 })

  const session = {
    header: { cwd: process.cwd(), parentSession: 'p1', origin: 'subagent', delegationDepth: 1 },
    append: (type: string, data: unknown, opts?: { surfaceOp?: unknown; sourceEventSeqs?: readonly number[] }) => {
      record(type, data, opts)
      return { seq: events.length - 1 }
    },
    ownEvents: () => [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'step/start', data: { turn: 1, step: 1 } },
    ],
  }
  const ctx = {
    get: (key: string) => {
      if (key === 'sessions') return { get: () => session }
      if (key === 'attachments') return opts?.attachments
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
    ...(opts?.maxAttempts !== undefined ? { maxAttempts: opts.maxAttempts } : {}),
    ...(opts?.retryDelayMs !== undefined ? { retryDelayMs: opts.retryDelayMs } : {}),
  })
  const seedTurnEnd = (): void => {
    record('step/end', { turn: 1, step: 1 })
    record('turn/end', { turn: 1, reason: { kind: 'completed' } })
  }
  return { adapter, events, seedTurnEnd }
}
