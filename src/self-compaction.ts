/**
 * 「这次压缩是 dsh 自己发起的」的会话级标记,供镜像层去重。
 *
 * ## 为什么需要
 * 手动 `/compact` 在 codebuddy 会话上转发给 CLI 后,命令自己的回执已经告诉用户
 * 「已让 CLI 压缩」;CLI 随后写出的那条 `summary` 再被镜像成一张压缩卡,同一次
 * 压缩就有了**两条消息**(实测 2026-09-15 09:04:命令回执 + 压缩卡同一秒出现)。
 * 镜像层的职责是让**CLI 自己触发**的压缩可见,dsh 自己发起的那次不该再镜像。
 *
 * ## 为什么按时间线而不是「下一个摘要」
 * CLI 的摘要记录是**惰性落盘**的:实测 09:04 那次手动压缩,它的 `summary` 直到
 * 09:16 下一次 prompt 才写出来。这中间镜像层会先看到一条**更早的、与本次无关**
 * 的摘要(实测 07:59 的自动压缩摘要,在 09:04 那一轮才被镜像层看到,于是压缩卡
 * 落在手动压缩的回执旁边——用户看到的就是这两条)。
 *
 * 所以判定读摘要自己的时刻,而不是「第几个」:
 * - 摘要时刻 **早于**发起时刻 → 本次转发之前漏看的那条,跳过但**保留**标记
 *   (本次转发自己的摘要还没到);
 * - 摘要时刻 **不早于**发起时刻 → 就是本次转发产生的,跳过并**清除**标记;
 * - 超过 {@link SELF_INITIATED_TTL_MS} → 标记作废。转发失败、或 CLI 决定没有
 *   可压内容时不会留下摘要,过期保证这种情况下标记不会永久吞掉后来的自动压缩。
 * @module subagent-codebuddy/self-compaction
 */

/**
 * 标记有效期。要盖住 CLI 惰性落盘的延迟(实测 12 分钟),又不能让一次没有产出的
 * 转发长期静音镜像——手动压完之后上下文很小,这段时间内 CLI 自己再触发压缩的
 * 概率也最低。
 */
export const SELF_INITIATED_TTL_MS = 30 * 60_000

/** 会话 id → 发起时刻(epoch ms)。 */
const selfInitiated = new Map<string, number>()

/**
 * 记下该会话刚刚由 dsh 自己发起了一次压缩转发。
 * @param sessionId - dsh 会话 id。
 * @param at - 发起时刻(epoch ms);应取**转发开始**的时刻,这样本次压缩自己的
 *   摘要(CLI 可能在转发期间就打好时间戳)不会被误判成"更早的那条"。
 */
export function markSelfInitiatedCompaction(sessionId: string, at: number): void {
  selfInitiated.set(sessionId, at)
}

/**
 * 这条 CLI 摘要是否属于一次 dsh 自己发起的压缩(属于则镜像层跳过它)。
 *
 * 会就地推进标记状态:命中"不早于发起时刻"的那条时清除标记。没有标记时返回
 * false,不产生任何副作用——镜像层的默认行为不变。
 * @param sessionId - dsh 会话 id。
 * @param summaryAt - 该 CLI 摘要自己的时间戳(epoch ms)。
 * @param now - 当前时刻(epoch ms),用于过期判定。
 * @returns 镜像层是否应跳过这条摘要。
 */
export function isSelfInitiatedCompaction(sessionId: string, summaryAt: number, now: number): boolean {
  const at = selfInitiated.get(sessionId)
  if (at === undefined) return false
  if (now - at > SELF_INITIATED_TTL_MS) {
    selfInitiated.delete(sessionId)
    return false
  }
  // 只有"本次转发之后产生的"那条才算是它的产出;更早的那条是漏看的旧压缩,
  // 跳过它但保留标记,等本次转发自己的摘要到达。
  if (summaryAt >= at) selfInitiated.delete(sessionId)
  return true
}

/** 测试用:清掉全部标记。 */
export function resetSelfInitiatedCompactionsForTests(): void {
  selfInitiated.clear()
}
