/**
 * 会话续接映射的持久化:dsh 会话 id → CodeBuddy ACP sessionId + 发送锚点。
 *
 * 服务重启后凭此恢复 CodeBuddy 侧的持久对话(session/load 续聊),而不是
 * 每次当作新会话从头灌历史。`sentCount` 记录上次发送 prompt 时 dsh 消息数,
 * 作为"补发缺失轮次"的切片锚点。
 * @module subagent-codebuddy/conversations
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 一条续接记录。 */
export interface ConversationRecord {
  /** CodeBuddy 侧 ACP sessionId。 */
  acpId: string
  /** 上次发送 prompt 时 dsh 消息总数(缺失轮次补发的锚点)。 */
  sentCount: number
  /**
   * 上次发送覆盖到的最后一条 dsh 消息 id(补发主锚——数量锚在压缩/编辑后
   * 不可靠,切模型再切回时会漏掉期间上下文)。
   */
  lastSentMessageId?: string
  /** 最后使用时间(逐出排序用)。 */
  at: number
}

/** 映射上限(超出按最久未使用逐出)。 */
const MAX_CONVERSATIONS = 2048
/** 落盘防抖。 */
const SAVE_DEBOUNCE_MS = 500

/** 默认存储文件:`~/.dsh/codebuddy/conversations.json`。 */
function defaultFile(): string {
  return join(homedir(), '.dsh', 'codebuddy', 'conversations.json')
}

/** 持久化的续接映射(纯内存模式用于测试:file = null)。 */
export class ConversationStore {
  private readonly map = new Map<string, ConversationRecord>()
  private saveTimer: ReturnType<typeof setTimeout> | undefined

  /**
   * @param file - 存储文件路径;`null` 为纯内存(测试用)。
   */
  constructor(private readonly file: string | null = defaultFile()) {
    this.load()
  }

  /** 读取会话的续接记录。 */
  get(sessionId: string): ConversationRecord | undefined {
    return this.map.get(sessionId)
  }

  /** 写入/更新续接记录(自动落盘)。 */
  set(sessionId: string, record: { acpId: string; sentCount: number; lastSentMessageId?: string }): void {
    this.map.set(sessionId, { ...record, at: Date.now() })
    while (this.map.size > MAX_CONVERSATIONS) {
      let oldestKey: string | undefined
      let oldestAt = Number.POSITIVE_INFINITY
      for (const [key, value] of this.map) {
        if (value.at < oldestAt) {
          oldestAt = value.at
          oldestKey = key
        }
      }
      if (oldestKey === undefined) break
      this.map.delete(oldestKey)
    }
    this.scheduleSave()
  }

  /** 删除会话记录(如 CodeBuddy 侧会话丢失时)。 */
  delete(sessionId: string): void {
    if (this.map.delete(sessionId)) this.scheduleSave()
  }

  private load(): void {
    if (this.file === null) return
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, Partial<ConversationRecord>>
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value?.acpId !== 'string') continue
        this.map.set(key, {
          acpId: value.acpId,
          sentCount: Number.isSafeInteger(value.sentCount) ? (value.sentCount as number) : 0,
          // 主锚必须随盘恢复:漏掉它会让重启后的补发退回数量锚——压缩/编辑后
          // 数量锚越界,切换模型期间的上下文会被静默丢弃。
          ...(typeof value.lastSentMessageId === 'string' && value.lastSentMessageId.length > 0
            ? { lastSentMessageId: value.lastSentMessageId }
            : {}),
          at: Number.isSafeInteger(value.at) ? (value.at as number) : 0,
        })
      }
    } catch {
      // 文件不存在或损坏:从空开始(下次变更重建)。
    }
  }

  private scheduleSave(): void {
    if (this.file === null || this.saveTimer !== undefined) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined
      this.saveNow()
    }, SAVE_DEBOUNCE_MS)
    this.saveTimer.unref?.()
  }

  private saveNow(): void {
    if (this.file === null) return
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.map), null, 2))
      renameSync(tmp, this.file)
    } catch {
      // 写失败不致命:映射仍在内存,下次变更再试。
    }
  }
}
