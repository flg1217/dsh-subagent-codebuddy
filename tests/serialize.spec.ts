/**
 * serialize(CodeBuddy prompt 序列化)单元测试:
 * - 系统提示 + 消息按顺序拼接;
 * - 图片块落盘为临时文件并给出本地路径提示;
 * - 超长 prompt 转临时任务文件引用(Windows 命令行 32K 限制);
 * - cleanup 清理临时文件。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildPrompt } from '../src/serialize.ts'
import type { Message } from '@deepseek-ai/dsh-llm'

let workspace: string

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'dsh-subagent-codebuddy-serialize-'))
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
})

/** 伪附件服务:readImage 返回图片字节与媒体类型。 */
function makeCtx() {
  const readImage = vi.fn(async () => ({
    data: new Uint8Array([1, 2, 3, 4]),
    ref: { mediaType: 'image/png' },
  }))
  const ctx = { get: (key: string) => (key === 'attachments' ? { readImage } : undefined) }
  return { ctx, readImage }
}

function textMessage(role: Message['role'], text: string): Message {
  return { role, content: [{ type: 'text', text }] }
}

describe('buildPrompt:文本序列化', () => {
  it('系统提示与消息按顺序拼接', async () => {
    const { ctx } = makeCtx()
    const { prompt, cleanup } = await buildPrompt(ctx as never, {
      system: '你是子代理。',
      messages: [
        textMessage('user', '你好'),
        textMessage('assistant', '你好,有什么可以帮你?'),
        textMessage('user', '分析这段代码'),
      ],
    })
    expect(prompt).toBe([
      'System instructions:\n你是子代理。',
      'User: 你好',
      'Assistant: 你好,有什么可以帮你?',
      'User: 分析这段代码',
    ].join('\n\n'))
    await cleanup()
  })

  it('无系统提示时只拼接消息', async () => {
    const { ctx } = makeCtx()
    const { prompt, cleanup } = await buildPrompt(ctx as never, {
      messages: [textMessage('user', 'hello')],
    })
    expect(prompt).toBe('User: hello')
    await cleanup()
  })

  it('同一消息多个文本块拼接在一起', async () => {
    const { ctx } = makeCtx()
    const { prompt, cleanup } = await buildPrompt(ctx as never, {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }],
    })
    expect(prompt).toBe('User: ab')
    await cleanup()
  })
})

describe('buildPrompt:图片处理', () => {
  it('图片块落盘为临时文件,并在 prompt 中给出本地路径提示', async () => {
    const { ctx, readImage } = makeCtx()
    const { prompt, cleanup } = await buildPrompt(ctx as never, {
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: '看图' },
          { type: 'image', attachment: { attachmentId: 'img-1' } },
        ],
      }],
    })
    expect(readImage).toHaveBeenCalledTimes(1)
    expect(prompt).toContain('User: 看图')
    expect(prompt).toMatch(/\[附带图片,请读取以下本地路径查看:.+codebuddy-.*\.png\]/)
    await cleanup()
  })

  it('图片读取失败时静默跳过,不影响文本', async () => {
    const ctx = { get: () => ({ readImage: vi.fn(async () => { throw new Error('boom') }) }) }
    const { prompt, cleanup } = await buildPrompt(ctx as never, {
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: '正文' },
          { type: 'image', attachment: { attachmentId: 'img-broken' } },
        ],
      }],
    })
    expect(prompt).toBe('User: 正文')
    await cleanup()
  })
})

describe('buildPrompt:超长 prompt 转任务文件', () => {
  it('超过阈值时 prompt 变为任务文件引用,内容完整写入临时文件', async () => {
    const { ctx } = makeCtx()
    const long = '长'.repeat(30_000)
    const { prompt, cleanup } = await buildPrompt(ctx as never, {
      messages: [textMessage('user', long)],
    })
    expect(prompt.length).toBeLessThan(300)
    expect(prompt).toContain('请先读取任务描述文件')
    const file = prompt.match(/codebuddy-task-[0-9a-f-]+\.txt/)?.[0]
    expect(file).toBeDefined()
    const full = readFileSync(join(tmpdir(), file), 'utf8')
    expect(full).toContain(long)
    await cleanup()
  })
})
