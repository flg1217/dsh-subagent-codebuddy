/**
 * 序列化模块:把 dsh 消息翻译为 CodeBuddy 单轮 prompt。
 * - 系统提示(可选)、对话消息按顺序拼接为文本;
 * - 图片块读字节后以 **ACP 原生 image 内容块**(base64)随 prompt 发送
 *   (`promptCapabilities.image` 实测支持,不再落盘走路径——避开 CodeBuddy
 *   Read 工具的 256KB 上限);
 * - 续聊补发(`resumeReplayPrompt`):从发送锚点切片,把切换模型期间缺失的
 *   轮次完整补上,同时跳过 CodeBuddy 自己产生的消息(其会话里已有)。
 * @module subagent-codebuddy/serialize
 */

import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'

/** 续跑兜底:仅当没有可补发内容时使用。 */
export const CONTINUE_PROMPT = '继续完成之前未完成的任务,持续推进直到任务完全完成或遇到必须用户决策的阻塞——不要每轮只做一小步就停下汇报。基于当前工作区状态继续,不要重复已完成的工作;全部完成后给出最终结果报告。启动 dev server 等长驻进程时必须用 Bash 的 run_in_background: true 参数后台运行——前台运行永不返回会卡死整个任务。'

/** 序列化结果:prompt 文本 + ACP 原生图片内容块(base64)。 */
export interface SerializedPrompt {
  prompt: string
  images: Array<{ data: string; mimeType: string }>
}

/** 一条消息的可读文本(text 块 + tool-result 内嵌文本;图片走内容块)。 */
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

/** 读取一组消息里的图片块(失败跳过),返回 ACP 原生内容块数据。 */
async function readImages(
  ctx: Context,
  messages: readonly Message[],
): Promise<Array<{ data: string; mimeType: string }>> {
  const attachments = ctx.get('attachments')
  if (attachments === undefined) return []
  const images: Array<{ data: string; mimeType: string }> = []
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type !== 'image') continue
      try {
        const stored = await attachments.readImage(block.attachment)
        images.push({
          data: Buffer.from(stored.data).toString('base64'),
          mimeType: stored.ref.mediaType,
        })
      } catch {
        // 附件不可读则跳过该图。
      }
    }
  }
  return images
}

/** 续聊兜底:只发最后一条真实用户消息(锚点缺失/历史被压缩收缩时)。 */
export async function lastUserPrompt(ctx: Context, messages: readonly Message[]): Promise<SerializedPrompt> {
  const last = [...messages].reverse().find(message => message.role === 'user' && message.source.kind !== 'tool')
  if (last === undefined) return { prompt: CONTINUE_PROMPT, images: [] }
  const text = messageText(last)
  const images = await readImages(ctx, [last])
  if (text.trim().length === 0 && images.length === 0) return { prompt: CONTINUE_PROMPT, images: [] }
  return { prompt: text, images }
}

/**
 * 续聊补发:把上次发送锚点(`sentCount`)之后的消息完整补发。
 *
 * 锚点之后先跳过 CodeBuddy 自己产生的消息(assistant 与 tool 结果——其会话里
 * 已有)与**已中途转发的插入消息**(`skipIds`——其文本已作为排队 prompt 送达,
 * 补发会重复),其余(切换其他模型期间产生的轮次、新的用户输入、压缩摘要等)
 * 全部按 User/Assistant 序列化发出。锚点缺失或历史被压缩收缩时退回最后一条用户消息。
 * @param ctx - 插件上下文(读取附件服务)。
 * @param messages - 当前 dsh 折叠视图的完整消息序列。
 * @param sentCount - 上次发送时的消息数锚点(未知则退回兜底)。
 * @param skipIds - 已在生成中转发过的插入消息 id 集合(可选)。
 * @returns 序列化结果(prompt + 原生图片块)。
 */
export async function resumeReplayPrompt(
  ctx: Context,
  messages: readonly Message[],
  sentCount: number | undefined,
  skipIds?: ReadonlySet<string>,
): Promise<SerializedPrompt> {
  if (sentCount === undefined || sentCount > messages.length) {
    return await lastUserPrompt(ctx, messages)
  }
  let index = sentCount
  while (index < messages.length) {
    const message = messages[index]!
    if (message.role === 'assistant' || message.source.kind === 'tool'
      || (skipIds !== undefined && skipIds.has(String(message.id)))) {
      index += 1
      continue
    }
    break
  }
  if (index >= messages.length) return { prompt: CONTINUE_PROMPT, images: [] }
  return await serializeMessages(ctx, messages.slice(index))
}

/** 把一组消息序列化为 prompt(无系统提示);图片走原生内容块。 */
export async function serializeMessages(
  ctx: Context,
  messages: readonly Message[],
): Promise<SerializedPrompt> {
  return serializeParts(ctx, [], messages)
}

/** 把 harness 消息序列化为 CodeBuddy 单轮 prompt;图片走原生内容块。 */
export async function buildPrompt(
  ctx: Context,
  options: GenerateOptions,
): Promise<SerializedPrompt> {
  const prefix: string[] = []
  if (options.system !== undefined && options.system.length > 0) {
    prefix.push(`System instructions:\n${options.system}`)
  }
  return serializeParts(ctx, prefix, options.messages)
}

/** 序列化主体:前缀(系统提示)+ 消息文本;图片收集为原生内容块。 */
async function serializeParts(
  ctx: Context,
  parts: string[],
  messages: readonly Message[],
): Promise<SerializedPrompt> {
  for (const message of messages) {
    const text = messageText(message)
    if (text.length === 0) continue
    const label = message.role === 'assistant' ? 'Assistant' : 'User'
    parts.push(`${label}: ${text}`)
  }
  return { prompt: parts.join('\n\n'), images: await readImages(ctx, messages) }
}
