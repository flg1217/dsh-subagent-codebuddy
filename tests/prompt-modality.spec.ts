/**
 * 读图引导分流测试:读图走 CLI 原生 Read(已放行;CLI 内置读图管线对任意模型
 * 适配——实测纯文本模型经 Read 读图也能看到图片内容,而 MCP 工具结果的图片
 * 会被 CLI 按模型能力过滤)。AGY 转述仅兜底(原生读图不可用)或用户显式要求;
 * 工具缺席时如实说明——尾注(promptTailFor)与 system 位
 * (systemInstructionsText)两侧口径一致。
 */
import { describe, expect, it } from 'vitest'
import { promptTailFor } from '../src/pump.ts'
import { systemInstructionsText } from '../src/serialize.ts'

describe('promptTailFor(读图引导)', () => {
  it('原生:指 Read 工具、说明由 CodeBuddy 侧适配,AGY 转述仅用户要求', () => {
    const delegate = promptTailFor('delegate', 'native')
    expect(delegate).toContain('读图片用 Read 工具')
    expect(delegate).toContain('CodeBuddy 侧适配')
    expect(delegate).toContain('除非用户明确要求')
    expect(delegate).not.toContain('读图片用 dsh_read_image_agy——')

    const mcp = promptTailFor('mcp', 'native')
    expect(mcp).toContain('读图片用 Read 工具')
    expect(mcp).toContain('CodeBuddy 侧适配')
  })

  it('AGY 兜底:指 read_image_agy 并说明没有原生读图工具', () => {
    const delegate = promptTailFor('delegate', 'agy')
    expect(delegate).toContain('读图片用 dsh_read_image_agy')
    expect(delegate).toContain('本会话没有可用的原生读图工具')
    expect(delegate).not.toContain('会被拒绝')

    const mcp = promptTailFor('mcp', 'agy')
    expect(mcp).toContain('读图片用 mcp__dsh__read_image_agy')
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
  it('原生:system 位同样指 Read(与桥接模式无关)', () => {
    const text = systemInstructionsText('SYS', false, 'mcp', 'native')
    expect(text).toContain('SYS')
    expect(text).toContain('读图片用 Read 工具')
    expect(text).toContain('CodeBuddy 侧适配')
    expect(text).not.toContain('会被拒绝')

    expect(systemInstructionsText('SYS', false, 'delegate', 'native')).toContain('读图片用 Read 工具')
  })

  it('AGY 兜底:system 位指 read_image_agy 并说明没有原生读图工具', () => {
    const text = systemInstructionsText('SYS', false, 'mcp', 'agy')
    expect(text).toContain('读图片用 mcp__dsh__read_image_agy')
    expect(text).toContain('本会话没有可用的原生读图工具')
    expect(text).not.toContain('原生支持图片输入')
  })

  it('工具缺席:如实说明', () => {
    const text = systemInstructionsText('SYS', false, 'delegate', 'unavailable')
    expect(text).toContain('没有可用的读图工具')
  })
})
