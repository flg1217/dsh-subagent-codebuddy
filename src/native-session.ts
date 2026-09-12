/**
 * dsh 消息 → CodeBuddy 原生会话记录(JSONL)转换器。
 *
 * 已有对话切换到 codebuddy 时,把折叠后的 dsh 历史写成 CodeBuddy 的
 * 项目会话文件(`~/.codebuddy/projects/<slug>/<sessionId>.jsonl`),再以
 * `session/load` 载入——历史以**原生消息**(user/assistant/工具调用)进入
 * CodeBuddy 会话,而不是压成一段提示词文本(实测:合成文件被接受,模型
 * 能正确引用其中内容)。
 *
 * 记录形态(取自真实会话文件):
 * - `message`: {id, timestamp, type:'message', role, content:[input_text|output_text]}
 * - `function_call`: {id, parentId, timestamp, type, callId, name, arguments}
 * - `function_call_result`: {id, parentId, timestamp, type, name, callId, status, output}
 * - id 为 UUIDv7(时间序);parentId 串链到前一条记录。
 * @module subagent-codebuddy/native-session
 */

import { randomBytes } from 'node:crypto'
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Message } from '@deepseek-ai/dsh-llm'
import { writeImageBlob } from './image-blob.js'

/** 一条 CodeBuddy 原生记录(宽松结构,字段与 CLI 写出的一致)。 */
export type NativeRecord = Record<string, unknown> & { type: string; id: string }

/** 转换上下文。 */
export interface NativeSessionContext {
  /** CodeBuddy 会话 id(同时是文件名)。 */
  sessionId: string
  /** 工作目录(记录内 cwd 与项目 slug 的来源)。 */
  cwd: string
}

/** 图片面:dsh attachment 引用 → 字节(写入 CodeBuddy blob)。 */
export interface NativeSessionImages {
  readImage: (ref: unknown) => Promise<{ data: Uint8Array; ref?: { mediaType?: string } }>
  /** blob 根目录(测试注入;默认 `~/.codebuddy/blobs`)。 */
  blobsRoot?: string
}

/** UUIDv7(时间序),与 CodeBuddy 记录 id 同构。 */
export function uuidv7(): string {
  const bytes = Buffer.alloc(16)
  let ts = BigInt(Date.now())
  for (let i = 5; i >= 0; i--) {
    bytes[i] = Number(ts & 0xffn)
    ts >>= 8n
  }
  randomBytes(10).copy(bytes, 6)
  bytes[6] = (bytes[6] & 0x0f) | 0x70
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** cwd → CodeBuddy 项目目录 slug(如 `H:\Projects\x` → `h-Projects-x`)。 */
export function projectSlug(cwd: string): string {
  return cwd
    .replace(/^([A-Za-z]):/, (_, drive: string) => drive.toLowerCase())
    .replace(/[:\\/]/g, '-')
}

/** 会话文件路径;baseDir 默认 `~/.codebuddy/projects`(测试可注入)。 */
export function conversationFilePath(sessionId: string, cwd: string, baseDir?: string): string {
  const root = baseDir ?? join(homedir(), '.codebuddy', 'projects')
  return join(root, projectSlug(cwd), `${sessionId}.jsonl`)
}

/** 一段消息的可读文本(text 块 + tool-result 内嵌文本;图片由调用方单独处理)。 */
function messageText(message: Message): string {
  const parts: string[] = []
  for (const block of message.content) {
    if (block.type === 'text') parts.push(block.text)
    else if (block.type === 'tool-result') {
      for (const inner of block.content) {
        if (inner.type === 'text') parts.push(inner.text)
      }
    }
  }
  return parts.join('')
}

/**
 * 把 dsh 消息序列转换为 CodeBuddy 原生记录。
 *
 * 映射:user → `message(input_text)`;assistant 文本 → `message(output_text)`;
 * assistant 的 tool-call 块 → `function_call`;tool 结果消息 → `function_call_result`;
 * reasoning 块跳过。user 消息的图片块写出 blob(内容寻址)后以原生
 * `image_blob_ref` 内容块进入记录;parentId 串链到前一条记录。
 * @param messages - 折叠视图的消息序列(压缩后的原始历史不会在这里出现)。
 * @param context - 会话 id 与工作目录。
 * @param images - 图片读取面(缺省时图片退化为 `[图片]` 文本占位)。
 * @returns 记录数组(按时间顺序,可直接写 JSONL)。
 */
export async function messagesToRecords(
  messages: readonly Message[],
  context: NativeSessionContext,
  images?: NativeSessionImages,
): Promise<NativeRecord[]> {
  const records: NativeRecord[] = []
  const toolNames = new Map<string, string>()
  let clock = Date.now()
  let parentId: string | undefined

  const stamp = (): number => {
    clock = Math.max(Date.now(), clock + 1)
    return clock
  }
  const base = (): Record<string, unknown> => ({
    sessionId: context.sessionId,
    cwd: context.cwd,
    ...(parentId === undefined ? {} : { parentId }),
  })
  const push = (record: Omit<NativeRecord, 'id'> & { type: string }): void => {
    const full = { id: uuidv7(), ...record } as NativeRecord
    records.push(full)
    parentId = full.id
  }

  for (const message of messages) {
    if (message.role === 'assistant') {
      const textParts: string[] = []
      for (const block of message.content) {
        if (block.type === 'text') {
          textParts.push(block.text)
        } else if (block.type === 'tool-call') {
          // 工具调用:先落地文本(若有),再写 function_call。
          if (textParts.length > 0) {
            push({
              timestamp: stamp(),
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: textParts.join(''), providerData: { annotations: [] } }],
              providerData: { agent: 'cli' },
              ...base(),
            })
            textParts.length = 0
          }
          toolNames.set(String(block.id), block.name)
          push({
            timestamp: stamp(),
            type: 'function_call',
            callId: String(block.id),
            name: block.name,
            arguments: block.arguments,
            providerData: { agent: 'cli' },
            ...base(),
          })
        }
        // reasoning 块跳过(原生 reasoning 记录结构随版本变化,不冒险合成)。
      }
      if (textParts.length > 0) {
        push({
          timestamp: stamp(),
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: textParts.join(''), providerData: { annotations: [] } }],
          providerData: { agent: 'cli' },
          ...base(),
        })
      }
      continue
    }
    // user 角色:普通输入或工具结果。
    if (message.source.kind === 'tool') {
      for (const block of message.content) {
        if (block.type !== 'tool-result') continue
        const callId = String(block.toolCallId)
        // 每条记录只带本块自己的文本(一条消息可能含多个 tool-result;
        // 之前整条拼接会让每个记录重复全部结果)。
        const resultParts: string[] = []
        for (const inner of block.content) {
          if (inner.type === 'text') resultParts.push(inner.text)
        }
        push({
          timestamp: stamp(),
          type: 'function_call_result',
          name: toolNames.get(callId) ?? 'tool',
          callId,
          status: 'completed',
          output: { type: 'text', text: resultParts.join('') },
          providerData: { agent: 'cli' },
          ...base(),
        })
      }
      continue
    }
    const text = messageText(message)
    const imageBlocks = message.content.filter(block => block.type === 'image')
    const content: Array<Record<string, unknown>> = []
    if (text.length > 0) content.push({ type: 'input_text', text })
    if (images !== undefined && imageBlocks.length > 0) {
      // 图片写 blob(内容寻址)后以原生 image_blob_ref 进入记录;失败跳过。
      for (const block of imageBlocks) {
        try {
          const stored = await images.readImage((block as { attachment?: unknown }).attachment)
          content.push({ ...writeImageBlob(stored.data, stored.ref?.mediaType ?? 'image/png', images.blobsRoot) })
        } catch { /* 读图失败 */ }
      }
    } else if (imageBlocks.length > 0) {
      content.push({ type: 'input_text', text: '[图片]' })
    }
    if (content.length === 0) continue
    push({
      timestamp: stamp(),
      type: 'message',
      role: 'user',
      content,
      __codebuddyLocal: { sensitiveUserInputReviewed: true },
      providerData: { agent: 'cli' },
      ...base(),
    })
  }
  return records
}

/** 会话文件的头部记录(CLI 自己也会写,合成时补一份保证结构完整)。 */
export function sessionMetaRecords(context: NativeSessionContext): NativeRecord[] {
  const now = Date.now()
  return [
    { id: uuidv7(), timestamp: now, type: 'session-meta', sessionId: context.sessionId, meta: { 'codebuddy.ai/hostKind': 'unopted' } } as NativeRecord,
  ]
}

/** 写入(覆盖)会话文件;原子写(tmp + rename)。 */
export function writeConversationFile(
  file: string,
  records: readonly NativeRecord[],
  context: NativeSessionContext,
): void {
  mkdirSync(dirname(file), { recursive: true })
  const lines = [
    ...sessionMetaRecords(context),
    ...records,
  ].map(record => JSON.stringify(record))
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${lines.join('\n')}\n`)
  renameSync(tmp, file)
}

/** 追加记录到已有会话文件(缺失轮次补写)。 */
export function appendConversationRecords(file: string, records: readonly NativeRecord[]): void {
  if (records.length === 0) return
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, `${records.map(record => JSON.stringify(record)).join('\n')}\n`)
}
