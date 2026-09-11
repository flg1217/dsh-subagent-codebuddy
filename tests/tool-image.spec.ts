/**
 * 工具结果图片转换:CodeBuddy 的 data URI 文本 JSON → dsh image 块。
 * - data URI 解析(合法/非法);
 * - 与原生 read_image 同形状(描述文本 + image 块);
 * - 未知块/入库失败/无服务面 → undefined(整体回退原文)。
 */
import { describe, expect, it, vi } from 'vitest'
import { imageReadAlias, parseImageDataUrl, toolResultBlocksFromText } from '../src/tool-image.ts'

/** 一段合法的 1x1 PNG base64(PNG 魔数开头)。 */
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
/** 解码后的字节数(测试断言用,避免硬编码)。 */
const PNG_BYTES = Buffer.from(PNG_B64, 'base64').byteLength

function makeFace(): {
  saveImage: (input: { data: Uint8Array; mediaType: string; name?: string }) => Promise<unknown>
  calls: Array<{ mediaType: string; bytes: number }>
} {
  const calls: Array<{ mediaType: string; bytes: number }> = []
  return {
    calls,
    saveImage: async (input) => {
      calls.push({ mediaType: input.mediaType, bytes: input.data.byteLength })
      return { attachmentId: 'sha256:test', mediaType: input.mediaType, bytes: input.data.byteLength, width: 1, height: 1 }
    },
  }
}

describe('tool-image:data URI 解析', () => {
  it('解析 image/png 与 image/jpeg', () => {
    expect(parseImageDataUrl(`data:image/png;base64,${PNG_B64}`)).toEqual({ mediaType: 'image/png', data: PNG_B64 })
    expect(parseImageDataUrl('data:image/jpeg;base64,AAAA')).toEqual({ mediaType: 'image/jpeg', data: 'AAAA' })
  })

  it('非 data URI / 非法 base64 → undefined', () => {
    expect(parseImageDataUrl('https://example.com/a.png')).toBeUndefined()
    expect(parseImageDataUrl('data:image/png;base64,')).toBeUndefined()
    expect(parseImageDataUrl('data:text/plain;base64,AAAA')).toBeUndefined()
    expect(parseImageDataUrl('data:image/png;base64,!!!')).toBeUndefined()
  })
})

describe('tool-image:工具输出转换', () => {
  it('image_url JSON → 描述文本 + image 块(入库字节正确)', async () => {
    const face = makeFace()
    const text = JSON.stringify([{ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_B64}` } }])
    const blocks = await toolResultBlocksFromText(face, text)
    expect(blocks).toBeDefined()
    expect(blocks).toHaveLength(2)
    expect(blocks![0]!['type']).toBe('text')
    expect(String(blocks![0]!['text'])).toContain('image/png')
    expect(blocks![1]).toEqual({ type: 'image', attachment: { attachmentId: 'sha256:test', mediaType: 'image/png', bytes: PNG_BYTES, width: 1, height: 1 } })
    expect(face.calls).toEqual([{ mediaType: 'image/png', bytes: PNG_BYTES }])
  })

  it('带 path 时产出原生同形信封(UI 图片卡片正则匹配)', async () => {
    const face = makeFace()
    const text = JSON.stringify([{ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_B64}` } }])
    const blocks = await toolResultBlocksFromText(face, text, 'D:/x/a.png')
    const envelope = String(blocks![0]!['text'])
    expect(envelope).toMatch(/^<path>[^\n]*<\/path>\n<type>image<\/type>\n<content>\n[\s\S]*\n<\/content>$/u)
    expect(envelope).toContain('<path>D:/x/a.png</path>')
  })

  it('混排文本 + 图片:顺序保留', async () => {
    const face = makeFace()
    const text = JSON.stringify([
      { type: 'text', text: '看这张图:' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_B64}` } },
    ])
    const blocks = await toolResultBlocksFromText(face, text)
    expect(blocks!.map(b => b['type'])).toEqual(['text', 'text', 'image'])
    expect(blocks![0]).toEqual({ type: 'text', text: '看这张图:' })
  })

  it('普通文本(非 JSON / 不含 image_url)→ undefined', async () => {
    const face = makeFace()
    expect(await toolResultBlocksFromText(face, 'hello world')).toBeUndefined()
    expect(await toolResultBlocksFromText(face, '[{"a":1}]')).toBeUndefined()
    expect(face.calls).toHaveLength(0)
  })

  it('未知块/非 data URI → undefined(整体回退)', async () => {
    const face = makeFace()
    expect(await toolResultBlocksFromText(face, JSON.stringify([{ type: 'image_url', image_url: { url: 'https://x/a.png' } }]))).toBeUndefined()
    expect(await toolResultBlocksFromText(face, JSON.stringify([{ type: 'audio', data: 'x' }]))).toBeUndefined()
    expect(face.calls).toHaveLength(0)
  })

  it('无服务面 / 入库抛错 → undefined', async () => {
    const text = JSON.stringify([{ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_B64}` } }])
    expect(await toolResultBlocksFromText(undefined, text)).toBeUndefined()
    const failing = { saveImage: vi.fn(async () => { throw new Error('no room') }) }
    expect(await toolResultBlocksFromText(failing, text)).toBeUndefined()
  })
})

describe('tool-image:read 别名', () => {
  it('图片路径的 Read → read_image + path(对象或 JSON 字符串)', () => {
    expect(imageReadAlias('Read', '{"file_path":"a.png"}')).toEqual({ name: 'read_image', path: 'a.png' })
    expect(imageReadAlias('read', { file_path: 'D:/x/design-system.JPEG' })).toEqual({ name: 'read_image', path: 'D:/x/design-system.JPEG' })
    expect(imageReadAlias('Read', '{"path":"/tmp/shot.webp"}')).toEqual({ name: 'read_image', path: '/tmp/shot.webp' })
  })

  it('非图片/非 Read/参数畸形 → undefined(保持原名)', () => {
    expect(imageReadAlias('Read', '{"file_path":"a.ts"}')).toBeUndefined()
    expect(imageReadAlias('Bash', '{"file_path":"a.png"}')).toBeUndefined()
    expect(imageReadAlias('Read', 'not json')).toBeUndefined()
    expect(imageReadAlias('Read', '{}')).toBeUndefined()
  })
})
