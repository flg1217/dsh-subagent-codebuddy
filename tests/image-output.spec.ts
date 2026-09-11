/**
 * parseCodebuddyImageOutput:CodeBuddy Read 读图的 rawOutput 解析。
 * 图片 data URI 必须转成字节+媒体类型,普通文本/非 JSON 输出保持原路径。
 */
import { describe, expect, it } from 'vitest'
import { parseCodebuddyImageOutput } from '../src/adapter.ts'

// 1x1 透明 PNG 的 base64(最小合法样本)
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

describe('parseCodebuddyImageOutput', () => {
  it('解析纯图片数组', () => {
    const out = parseCodebuddyImageOutput(
      JSON.stringify([{ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_B64}` } }]),
    )
    expect(out).toBeDefined()
    expect(out!.images).toHaveLength(1)
    expect(out!.images[0]!.mediaType).toBe('image/png')
    expect(out!.images[0]!.data.byteLength).toBeGreaterThan(0)
    expect(out!.text).toBe('')
  })

  it('解析 text + image 混合数组', () => {
    const out = parseCodebuddyImageOutput(
      JSON.stringify([
        { type: 'text', text: '这是设计稿' },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${PNG_B64}` } },
      ]),
    )
    expect(out!.text).toBe('这是设计稿')
    expect(out!.images[0]!.mediaType).toBe('image/jpeg')
  })

  it('多张图片', () => {
    const out = parseCodebuddyImageOutput(
      JSON.stringify([
        { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_B64}` } },
        { type: 'image_url', image_url: { url: `data:image/webp;base64,${PNG_B64}` } },
      ]),
    )
    expect(out!.images).toHaveLength(2)
  })

  it('非 JSON / 非数组 / 无 image_url 返回 undefined(走原文本路径)', () => {
    expect(parseCodebuddyImageOutput('普通工具输出文本')).toBeUndefined()
    expect(parseCodebuddyImageOutput('{"type":"text"}')).toBeUndefined()
    expect(parseCodebuddyImageOutput('[{"type":"text","text":"no image"}]')).toBeUndefined()
    expect(parseCodebuddyImageOutput('[broken json')).toBeUndefined()
  })

  it('image_url 非法(非 data URI)时忽略该项', () => {
    expect(parseCodebuddyImageOutput(
      JSON.stringify([{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }]),
    )).toBeUndefined()
  })
})
