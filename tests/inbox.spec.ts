/**
 * inbox 折叠测试:dsh `agent/inbox/spliced` → 尚未 claim 的用户插入。
 */
import { describe, expect, it } from 'vitest'
import { foldPendingInsertions } from '../src/inbox.ts'

function userMessage(id: string, text: string) {
  return { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

describe('foldPendingInsertions', () => {
  it('splice 插入的用户消息为待转发;claim(removedCount)后消失', () => {
    const events = [
      { type: 'turn/start', data: { turn: 1 } },
      {
        type: 'agent/inbox/spliced',
        data: { target: 'next-step', start: 0, inserted: [userMessage('ins-1', '插话')] },
      },
    ]
    expect(foldPendingInsertions(events)).toEqual([{ id: 'ins-1', text: '插话', steer: true }])

    // 被 claim:同位置移除。
    events.push({
      type: 'agent/inbox/spliced',
      data: { target: 'next-step', start: 0, removedCount: 1, inserted: [] as unknown[] },
    })
    expect(foldPendingInsertions(events)).toEqual([])
  })

  it('非 user 来源(插件注入)保留位置对齐但不转发', () => {
    const events = [
      {
        type: 'agent/inbox/spliced',
        data: {
          target: 'next-step',
          start: 0,
          inserted: [
            { id: 'ctx-1', role: 'user', content: [{ type: 'text', text: '<system-reminder>内部</system-reminder>' }], source: { kind: 'plugin' } },
            userMessage('ins-2', '真插话'),
          ],
        },
      },
    ]
    expect(foldPendingInsertions(events)).toEqual([{ id: 'ins-2', text: '真插话', steer: true }])
  })

  it('多 target 队列独立;同 id 去重;空文本跳过;next-turn 是排队而非插话', () => {
    const events = [
      {
        type: 'agent/inbox/spliced',
        data: { target: 'next-turn', start: 0, inserted: [userMessage('ins-a', 'A')] },
      },
      {
        type: 'agent/inbox/spliced',
        data: { target: 'next-step', start: 0, inserted: [userMessage('ins-b', 'B'), userMessage('ins-empty', '   ')] },
      },
    ]
    const folded = foldPendingInsertions(events)
    expect(folded.map(item => item.id).sort()).toEqual(['ins-a', 'ins-b'])
    expect(folded.find(item => item.id === 'ins-a')?.steer).toBe(false)
    expect(folded.find(item => item.id === 'ins-b')?.steer).toBe(true)
  })

  it('排队消息被「立即发送」:从 next-turn 移到 next-step 后按插话转发', () => {
    const events = [
      {
        type: 'agent/inbox/spliced',
        data: { target: 'next-turn', start: 0, inserted: [userMessage('ins-move', '改成先做 B')] },
      },
    ]
    expect(foldPendingInsertions(events)).toEqual([{ id: 'ins-move', text: '改成先做 B', steer: false }])
    // updateQueue(steer):从 next-turn 移除 + 前插到 next-step。
    events.push(
      { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] as unknown[] } },
      { type: 'agent/inbox/spliced', data: { target: 'next-step', start: 0, inserted: [userMessage('ins-move', '改成先做 B')] } },
    )
    expect(foldPendingInsertions(events)).toEqual([{ id: 'ins-move', text: '改成先做 B', steer: true }])
  })
})
