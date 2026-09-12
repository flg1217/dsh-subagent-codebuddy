/**
 * serialize(CodeBuddy prompt 序列化)单元测试:
 * - 系统提示 + 消息按顺序拼接;
 * - 图片块以 ACP 原生 image 内容块(base64)返回,不落盘、不走路径提示;
 * - 超长 prompt 内联返回(经 ACP stdin 发送,无命令行长度限制)。
 */
import { describe, expect, it, vi } from 'vitest'
import { buildPrompt, lastUserPrompt, resumeReplayPrompt } from '../src/serialize.ts'
import type { Message } from '@deepseek-ai/dsh-llm'

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
    const { prompt, images } = await buildPrompt(ctx as never, {
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
    expect(images).toEqual([])
  })

  it('无系统提示时只拼接消息', async () => {
    const { ctx } = makeCtx()
    const { prompt } = await buildPrompt(ctx as never, {
      messages: [textMessage('user', 'hello')],
    })
    expect(prompt).toBe('User: hello')
  })

  it('同一消息多个文本块拼接在一起', async () => {
    const { ctx } = makeCtx()
    const { prompt } = await buildPrompt(ctx as never, {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }],
    })
    expect(prompt).toBe('User: ab')
  })
})

describe('buildPrompt:图片处理(ACP 原生内容块)', () => {
  it('图片块转为 base64 内容块;prompt 里不含路径提示', async () => {
    const { ctx, readImage } = makeCtx()
    const { prompt, images } = await buildPrompt(ctx as never, {
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: '看图' },
          { type: 'image', attachment: { attachmentId: 'img-1' } },
        ],
      }],
    })
    expect(readImage).toHaveBeenCalledTimes(1)
    expect(prompt).toBe('User: 看图')
    expect(prompt).not.toContain('附带图片')
    expect(images).toEqual([{ data: Buffer.from([1, 2, 3, 4]).toString('base64'), mimeType: 'image/png' }])
  })

  it('图片读取失败时静默跳过,不影响文本', async () => {
    const ctx = { get: () => ({ readImage: vi.fn(async () => { throw new Error('boom') }) }) }
    const { prompt, images } = await buildPrompt(ctx as never, {
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: '正文' },
          { type: 'image', attachment: { attachmentId: 'img-broken' } },
        ],
      }],
    })
    expect(prompt).toBe('User: 正文')
    expect(images).toEqual([])
  })

  it('lastUserPrompt:只取最后一条用户消息(含其图片内容块)', async () => {
    const { ctx } = makeCtx()
    const { prompt, images } = await lastUserPrompt(ctx as never, [
      textMessage('user', '旧问题'),
      textMessage('assistant', '旧回答'),
      {
        role: 'user',
        content: [
          { type: 'text', text: '新问题带图' },
          { type: 'image', attachment: { attachmentId: 'img-2' } },
        ],
        source: { kind: 'user' },
      } as unknown as Message,
    ])
    expect(prompt).toBe('新问题带图')
    expect(images.length).toBe(1)
  })
})

describe('buildPrompt:超长 prompt 内联直发', () => {
  it('无论多长都内联返回原文,不再生成任务文件引用', async () => {
    const { ctx } = makeCtx()
    const long = '长'.repeat(30_000)
    const { prompt } = await buildPrompt(ctx as never, {
      messages: [textMessage('user', long)],
    })
    expect(prompt).toContain(long)
    expect(prompt).not.toContain('请先读取任务描述文件')
  })
})

describe('resumeReplayPrompt:已转发插入的去重', () => {
  it('skipIds 里的插入消息被跳过,不重复补发', async () => {
    const { ctx } = makeCtx()
    const messages = [
      { id: 'u1', role: 'user', content: [{ type: 'text', text: '第一问' }], source: { kind: 'user' } },
      { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '第一答' }], source: { kind: 'model', provider: 'codebuddy', model: 'x' } },
      { id: 'ins-1', role: 'user', content: [{ type: 'text', text: '插话:先别做别的' }], source: { kind: 'user' } },
      { id: 'a2', role: 'assistant', content: [{ type: 'text', text: '插话的回复' }], source: { kind: 'model', provider: 'codebuddy', model: 'x' } },
      { id: 'u2', role: 'user', content: [{ type: 'text', text: '新问题' }], source: { kind: 'user' } },
    ] as unknown as Message[]
    const { resumeReplayPrompt } = await import('../src/serialize.ts')
    const { prompt } = await resumeReplayPrompt(ctx as never, messages, 2, new Set(['ins-1']))
    expect(prompt).toContain('新问题')
    expect(prompt).not.toContain('插话')
  })
})

describe('lastUserPrompt:插件注入上下文不顶掉用户输入', () => {
  it('系统提醒(plugin)排在用户消息之后时,仍取用户消息(压缩后排队消息丢失回归)', async () => {
    const { ctx } = makeCtx()
    const messages = [
      { role: 'user', content: [{ type: 'text', text: '账本设计还是过度设计' }], source: { kind: 'user' } },
      {
        role: 'user',
        content: [{ type: 'text', text: '<system-reminder>技能目录已更新</system-reminder>' }],
        source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-skill' },
      },
      {
        role: 'user',
        content: [{ type: 'text', text: 'Current runtime context…' }],
        source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' },
      },
    ] as unknown as Message[]
    const { prompt } = await lastUserPrompt(ctx as never, messages)
    expect(prompt).toBe('账本设计还是过度设计')
  })

  it('只有插件上下文时退回 CONTINUE_PROMPT(不把提醒当用户输入)', async () => {
    const { ctx } = makeCtx()
    const messages = [
      {
        role: 'user',
        content: [{ type: 'text', text: '<system-reminder>技能目录</system-reminder>' }],
        source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-skill' },
      },
    ] as unknown as Message[]
    const { prompt } = await lastUserPrompt(ctx as never, messages)
    expect(prompt).toContain('继续完成之前未完成的任务')
  })
})

describe('resumeReplayPrompt:只有已插话投递的消息可跳过', () => {
  /** 用户消息(带 id,便于 skipIds 命中)。 */
  function userMessage(id: string, text: string): Message {
    return { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } as unknown as Message
  }

  it('锚点之后全是"已插话投递"的消息 → skippedForwarded=true(调用方空跑,不发 CONTINUE_PROMPT)', async () => {
    const { ctx } = makeCtx()
    const messages = [
      userMessage('m-old', '旧输入'),
      userMessage('m-steer', '插句话:先别做别的'),
    ]
    const replay = await resumeReplayPrompt(ctx as never, messages, 1, new Set(['m-steer']))
    expect(replay.skippedForwarded).toBe(true)
    expect(replay.prompt).toContain('继续完成之前未完成的任务')   // 兜底文本仍在,由调用方决定不用
  })

  it('跳过的是 CodeBuddy 自己的消息 → skippedForwarded 不置位(仍走续跑)', async () => {
    const { ctx } = makeCtx()
    const messages = [
      userMessage('m-old', '旧输入'),
      {
        id: 'm-own',
        role: 'assistant',
        content: [{ type: 'text', text: '我自己产出的' }],
        source: { kind: 'model', provider: 'codebuddy', model: 'glm-5.3' },
      } as unknown as Message,
    ]
    const replay = await resumeReplayPrompt(ctx as never, messages, 1, new Set())
    expect(replay.skippedForwarded).toBe(false)
  })

  it('切换其他模型再切回:期间其他模型的回答被补发(只跳过 CodeBuddy 自己的)', async () => {
    const { ctx } = makeCtx()
    const messages = [
      userMessage('m-old', '旧输入'),
      {
        id: 'm-own',
        role: 'assistant',
        content: [{ type: 'text', text: '我自己的回答' }],
        source: { kind: 'model', provider: 'codebuddy', model: 'glm-5.3' },
      } as unknown as Message,
      {
        id: 'm-other',
        role: 'assistant',
        content: [{ type: 'text', text: '别的模型的回答' }],
        source: { kind: 'model', provider: 'sensenova', model: 'kimi-k3' },
      } as unknown as Message,
      userMessage('m-new', '切回后的新输入'),
    ]
    const replay = await resumeReplayPrompt(ctx as never, messages, 1, new Set())
    expect(replay.prompt).toContain('别的模型的回答')
    expect(replay.prompt).toContain('切回后的新输入')
    expect(replay.prompt).not.toContain('我自己的回答')
  })

  it('锚点之后还有新输入 → 正常序列化新输入(S 不置位)', async () => {
    const { ctx } = makeCtx()
    const messages = [
      userMessage('m-old', '旧输入'),
      userMessage('m-steer', '插句话'),
      userMessage('m-new', '新的输入'),
    ]
    const replay = await resumeReplayPrompt(ctx as never, messages, 1, new Set(['m-steer']))
    expect(replay.skippedForwarded).toBeUndefined()
    expect(replay.prompt).toContain('新的输入')
    expect(replay.prompt).not.toContain('插句话')
  })
})
