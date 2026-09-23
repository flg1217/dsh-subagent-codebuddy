/**
 * 读图引导分流测试:多模态模型指 read_image(图片直进上下文),仅文本模型指
 * read_image_agy(AGY 转述),工具缺席时如实说明——尾注(promptTailFor)与
 * system 位(systemInstructionsText)两侧口径一致。
 */
import { describe, expect, it } from 'vitest'
import { promptTailFor } from '../src/pump.ts'
import { systemInstructionsText } from '../src/serialize.ts'

describe('promptTailFor(读图引导)', () => {
  it('多模态:指 read_image 并明确不要改用 read_image_agy 转述', () => {
    const delegate = promptTailFor('delegate', 'native')
    expect(delegate).toContain('读图片用 dsh_read_image')
    expect(delegate).toContain('原生支持图片输入')
    expect(delegate).not.toContain('读图片一律用 dsh_read_image_agy')

    const mcp = promptTailFor('mcp', 'native')
    expect(mcp).toContain('读图片用 mcp__dsh__read_image')
    expect(mcp).toContain('原生支持图片输入')
  })

  it('仅文本:指 read_image_agy 并说明 read_image 会被拒', () => {
    const delegate = promptTailFor('delegate', 'agy')
    expect(delegate).toContain('读图片一律用 dsh_read_image_agy')
    expect(delegate).toContain('纯文本模型')
    expect(delegate).toContain('会被拒绝')
    expect(delegate).not.toContain('读图片用 dsh_read_image——')

    const mcp = promptTailFor('mcp', 'agy')
    expect(mcp).toContain('读图片一律用 mcp__dsh__read_image_agy')
  })

  it('工具缺席:如实说明,不指路不存在的工具', () => {
    const note = promptTailFor('delegate', 'unavailable')
    expect(note).toContain('没有可用的读图工具')
    expect(note).not.toContain('dsh_read_image_agy')
  })

  it('缺省 guidance = native(保持旧文案)', () => {
    expect(promptTailFor('delegate')).toBe(promptTailFor('delegate', 'native'))
    expect(promptTailFor('mcp')).toBe(promptTailFor('mcp', 'native'))
  })
})

describe('systemInstructionsText(读图引导)', () => {
  it('多模态:system 位同样指 read_image(带模式前缀)', () => {
    const text = systemInstructionsText('SYS', false, 'mcp', 'native')
    expect(text).toContain('SYS')
    expect(text).toContain('读图片用 mcp__dsh__read_image')
    expect(text).toContain('原生支持图片输入')
    expect(text).not.toContain('read_image 会被拒绝')

    expect(systemInstructionsText('SYS', false, 'delegate', 'native')).toContain('读图片用 dsh_read_image')
  })

  it('仅文本:system 位指 read_image_agy 并说明会被拒', () => {
    const text = systemInstructionsText('SYS', false, 'mcp', 'agy')
    expect(text).toContain('读图片一律用 mcp__dsh__read_image_agy')
    expect(text).toContain('会被拒绝')
    expect(text).not.toContain('原生支持图片输入')
  })

  it('工具缺席:如实说明', () => {
    const text = systemInstructionsText('SYS', false, 'delegate', 'unavailable')
    expect(text).toContain('没有可用的读图工具')
  })
})
