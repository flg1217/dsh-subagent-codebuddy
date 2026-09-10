/**
 * ConversationStore 测试:落盘/重载、损坏容错、最久未使用逐出。
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConversationStore } from '../src/conversations.ts'

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'codebuddy-store-')), 'conversations.json')
}

describe('ConversationStore', () => {
  it('写入后可重载(跨重启恢复)', () => {
    const file = tempFile()
    const store = new ConversationStore(file)
    store.set('session-a', { acpId: 'acp-1', sentCount: 7 })
    // 等防抖落盘
    return new Promise<void>(resolve => setTimeout(resolve, 700)).then(() => {
      const reloaded = new ConversationStore(file)
      expect(reloaded.get('session-a')).toMatchObject({ acpId: 'acp-1', sentCount: 7 })
    })
  })

  it('文件损坏时从空开始,不抛错', () => {
    const file = tempFile()
    writeFileSync(file, 'not json{{{')
    const store = new ConversationStore(file)
    expect(store.get('anything')).toBeUndefined()
    store.set('s', { acpId: 'a', sentCount: 0 })
    expect(store.get('s')?.acpId).toBe('a')
  })

  it('超过上限时逐出最久未使用', async () => {
    const file = tempFile()
    const store = new ConversationStore(file)
    store.set('oldest', { acpId: 'x', sentCount: 0 })
    await new Promise(resolve => setTimeout(resolve, 5))
    for (let i = 0; i < 2100; i++) store.set(`s-${String(i)}`, { acpId: `a-${String(i)}`, sentCount: i })
    // oldest 的时间戳最小,应被逐出;最新写入仍在。
    expect(store.get('oldest')).toBeUndefined()
    expect(store.get('s-2099')?.acpId).toBe('a-2099')
  })

  it('delete 后不再返回', () => {
    const store = new ConversationStore(null)
    store.set('s', { acpId: 'a', sentCount: 1 })
    expect(store.get('s')).toBeDefined()
    store.delete('s')
    expect(store.get('s')).toBeUndefined()
  })

  it('落盘格式为 JSON 对象(键 = dsh 会话 id)', async () => {
    const file = tempFile()
    const store = new ConversationStore(file)
    store.set('dsh-1', { acpId: 'acp-9', sentCount: 3 })
    await new Promise(resolve => setTimeout(resolve, 700))
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    expect(parsed['dsh-1']).toMatchObject({ acpId: 'acp-9', sentCount: 3 })
  })
})
