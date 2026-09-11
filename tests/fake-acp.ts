/**
 * 极简 ACP 假进程(与 adapter-acp.spec.ts 相同的模式,供新用例复用):
 * mock spawn 得到双向 JSON-RPC(ndjson)——stdin 收 adapter 请求,
 * stdout 按脚本回响应/推 update。
 */
import { EventEmitter } from 'node:events'
import type { spawn } from 'node:child_process'
import { Readable as ReadableStream, Readable } from 'node:stream'

export interface FakeAcp {
  proc: EventEmitter & { stdin: unknown; stdout: Readable; stderr: Readable; kill: () => void }
  onRequest(handler: (msg: { id: number; method: string; params: Record<string, unknown> }) => void): void
  respond(id: number, result: unknown): void
  respondError(id: number, error: { code: number; message: string; data?: unknown }): void
  update(update: Record<string, unknown>): void
  close(code: number | null): void
  requestLog(): string[]
  notifications(): Array<{ method: string; params: Record<string, unknown> }>
}

let last: FakeAcp | undefined

/** 最近一次创建的假进程(供断言)。 */
export function lastFake(): FakeAcp | undefined {
  return last
}

/** 新建假 ACP 进程。 */
export function fakeAcpProc(): FakeAcp {
  const proc = new EventEmitter() as FakeAcp['proc']
  const stdout = new Readable({ read(): void {} })
  const stderr = new Readable({ read(): void {} })
  let stdinBuffer = ''
  const requests: Array<{ id: number; method: string }> = []
  const notifs: Array<{ method: string; params: Record<string, unknown> }> = []
  let handler: (msg: { id: number; method: string; params: Record<string, unknown> }) => void = () => {}
  const stdin = new ReadableStream({ read(): void {} })
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
  const fake = proc as unknown as FakeAcp
  fake.onRequest = (h): void => {
    const prev = handler
    handler = msg => {
      prev(msg)
      h(msg)
    }
  }
  fake.respond = (id, result): void => {
    stdout.push(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
  }
  fake.respondError = (id, error): void => {
    stdout.push(`${JSON.stringify({ jsonrpc: '2.0', id, error })}\n`)
  }
  fake.update = (update): void => {
    stdout.push(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'cb-1', update } })}\n`)
  }
  fake.close = (code): void => {
    stdout.push(null)
    setTimeout(() => proc.emit('close', code, null), 5)
  }
  fake.requestLog = (): string[] => requests.map(r => r.method)
  fake.notifications = (): Array<{ method: string; params: Record<string, unknown> }> => notifs
  last = fake
  return fake
}

/** 常规握手脚本:initialize / session/new / session/load 自动应答。 */
export function autoHandshake(f: FakeAcp): void {
  f.onRequest(msg => {
    if (msg.method === 'initialize') f.respond(msg.id, { protocolVersion: 1, agentCapabilities: { loadSession: true } })
    else if (msg.method === 'session/new') f.respond(msg.id, { sessionId: 'cb-1' })
    else if (msg.method === 'session/load') f.respond(msg.id, {})
  })
}

/** ACP update 快捷构造。 */
export const thought = (text: string, messageId = 'm-thought'): Record<string, unknown> => ({
  sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text }, messageId,
})
export const message = (text: string, messageId = 'm-msg'): Record<string, unknown> => ({
  sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }, messageId,
})
export const toolCall = (
  id: string,
  toolName: string,
  rawInput: Record<string, unknown>,
  status = 'pending',
): Record<string, unknown> => ({
  sessionUpdate: 'tool_call',
  toolCallId: id,
  title: `\`${JSON.stringify(rawInput)}\``,
  kind: 'execute',
  status,
  rawInput,
  _meta: { 'codebuddy.ai/toolName': toolName, 'codebuddy.ai/toolArgumentsComplete': status === 'pending' },
})
export const toolUpdate = (id: string, status: 'completed' | 'failed', output: string): Record<string, unknown> => ({
  sessionUpdate: 'tool_call_update', toolCallId: id, status, rawOutput: { type: 'text', text: output },
})
/** agentPhase 心跳(模型调用边界信号)。 */
export const phase = (name: string): Record<string, unknown> => ({
  sessionUpdate: 'session_info_update',
  _meta: { 'codebuddy.ai/agentPhase': { phase: name } },
})
/** usage_update(每次模型调用一条)。 */
export const usage = (payload: Record<string, unknown>): Record<string, unknown> => ({
  sessionUpdate: 'usage_update',
  _meta: { usage: payload },
})
/** CLI 空闲广播。 */
export const sessionEnd = (): Record<string, unknown> => ({ sessionUpdate: 'session_end' })

/** 把假进程转成 mock spawn 的返回类型(假对象本身就是 proc)。 */
export function asSpawnResult(f: FakeAcp): ReturnType<typeof spawn> {
  return f as unknown as ReturnType<typeof spawn>
}
