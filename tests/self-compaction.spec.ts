/**
 * 「这次压缩是 dsh 自己发起的」标记:镜像层据此跳过 CLI 随之写出的摘要,
 * 同一次手动压缩就不会出现两条消息(命令回执 + 压缩卡)。
 *
 * 判定按**时间线**而不是「第几条摘要」:CLI 的摘要是惰性落盘的,手动压缩那一轮
 * 镜像层往往先看到一条更早的、与本次无关的摘要。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  isSelfInitiatedCompaction,
  markSelfInitiatedCompaction,
  resetSelfInitiatedCompactionsForTests,
  SELF_INITIATED_TTL_MS,
} from '../src/self-compaction.ts'

const SESSION = 'session-1'
const T = 1_700_000_000_000

beforeEach(() => {
  resetSelfInitiatedCompactionsForTests()
})

describe('self-compaction:摘要归属判定', () => {
  it('没有标记时不认领任何摘要(镜像层默认行为不变)', () => {
    expect(isSelfInitiatedCompaction(SESSION, T, T)).toBe(false)
  })

  it('摘要时刻不早于发起时刻 → 认领并清除标记', () => {
    markSelfInitiatedCompaction(SESSION, T)

    expect(isSelfInitiatedCompaction(SESSION, T, T)).toBe(true)
    // 已清除:下一条摘要不再被认领。
    expect(isSelfInitiatedCompaction(SESSION, T, T)).toBe(false)
  })

  it('摘要时刻早于发起时刻 → 认领但保留标记(本次转发的摘要还没到)', () => {
    markSelfInitiatedCompaction(SESSION, T)

    // 手动压缩那一轮先看到的是更早的自动压缩摘要。
    expect(isSelfInitiatedCompaction(SESSION, T - 60_000, T)).toBe(true)
    // 标记仍在 → 本次转发自己的摘要到达时照样被认领并清除。
    expect(isSelfInitiatedCompaction(SESSION, T + 1, T + 1)).toBe(true)
    expect(isSelfInitiatedCompaction(SESSION, T + 2, T + 2)).toBe(false)
  })

  it('标记过期 → 作废且不再认领(转发没产出时不会永久静音)', () => {
    markSelfInitiatedCompaction(SESSION, T)
    const now = T + SELF_INITIATED_TTL_MS + 1

    expect(isSelfInitiatedCompaction(SESSION, now, now)).toBe(false)
    // 过期即已作废,后续摘要同样不再被认领。
    expect(isSelfInitiatedCompaction(SESSION, now + 1, now + 1)).toBe(false)
  })

  it('标记按会话隔离', () => {
    markSelfInitiatedCompaction(SESSION, T)

    expect(isSelfInitiatedCompaction('session-2', T, T)).toBe(false)
    expect(isSelfInitiatedCompaction(SESSION, T, T)).toBe(true)
  })
})
