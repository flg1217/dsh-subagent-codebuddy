/**
 * dsh 中途插入(`agent/inbox/spliced`)折叠。
 *
 * dsh 允许生成过程中插入新的用户消息:消息先进 per-target 的 inbox
 * (splice 事件落会话日志,`inserted` 插入到 `start`),在下一个 step/turn
 * 边界被 claim 后才成为 `user/message`。codebuddy 轮是单个长 step,插入
 * 会一直悬挂——本模块折叠出**尚未被 claim 的用户消息**,供适配器转发给
 * 运行中的 CodeBuddy:`next-step`(插话)走 ACP `session/steer` 立即注入,
 * `next-turn` 排队为 prompt。
 *
 * 队列按 target 分开维护;非 user 来源(插件注入的 context 等)保留在队列里
 * 参与位置对齐,但不出现在结果中。
 * @module subagent-codebuddy/inbox
 */

/** 一条悬挂待领的用户插入。 */
export interface PendingInsertion {
  /** 消息 id(与后续 user/message 事件同 id,用于去重)。 */
  id: string
  /** 文本内容。 */
  text: string
  /**
   * 是否插话(`next-step` 队列):插话应立即投递给运行中的 CodeBuddy
   * (ACP `session/steer`);`next-turn` 只排队,等当前工作结束。
   */
  steer: boolean
}

interface QueueEntry {
  id: string
  text: string
  fromUser: boolean
}

/** 消息文本(text 块拼接)。 */
function textOf(message: unknown): string {
  const content = (message as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text ?? '')
    .join('')
}

/**
 * 折叠会话事件里的 inbox splice,得到尚未 claim 的用户消息。
 * @param events - 会话自身事件(ownEvents)。
 * @returns 悬挂的用户插入(按事件顺序;同 id 只出现一次)。
 */
export function foldPendingInsertions(
  events: readonly { type: string; data?: unknown }[],
): PendingInsertion[] {
  const queues = new Map<string, QueueEntry[]>()
  for (const event of events) {
    if (event.type !== 'agent/inbox/spliced') continue
    const data = event.data as
      | { target?: unknown; start?: unknown; removedCount?: unknown; inserted?: unknown }
      | undefined
    if (typeof data?.target !== 'string') continue
    const queue = queues.get(data.target) ?? []
    const start = typeof data.start === 'number' ? data.start : 0
    const removedCount = typeof data.removedCount === 'number' ? data.removedCount : 0
    if (removedCount > 0) queue.splice(start, removedCount)
    if (Array.isArray(data.inserted) && data.inserted.length > 0) {
      const entries: QueueEntry[] = data.inserted.map(raw => {
        const message = raw as { id?: unknown; source?: { kind?: unknown } } | undefined
        const kind = message?.source?.kind
        return {
          id: typeof message?.id === 'string' ? message.id : '',
          text: textOf(raw),
          fromUser: kind === 'user',
        }
      })
      queue.splice(start, 0, ...entries)
    }
    queues.set(data.target, queue)
  }
  const seen = new Set<string>()
  const pending: PendingInsertion[] = []
  for (const [target, queue] of queues) {
    for (const entry of queue) {
      if (!entry.fromUser || entry.id.length === 0 || entry.text.trim().length === 0) continue
      if (seen.has(entry.id)) continue
      seen.add(entry.id)
      pending.push({ id: entry.id, text: entry.text, steer: target === 'next-step' })
    }
  }
  return pending
}
