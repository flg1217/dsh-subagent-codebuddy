/**
 * CodeBuddy stream-json 翻译器的消息类型接入测试:
 * - thinking 块(字段名 `thinking`)→ reasoning 块 —— 之前读 block.text
 *   永远为空,子代理窗口只剩一排工具调用卡;
 * - text 块 → text 块;
 * - tool_use → tool/call 步骤;
 * - 真实 CLI 事件序列(思考→文本→工具交替)全链路。
 */
import { describe, expect, it } from 'vitest'
import { CodebuddyTranslator } from '../src/translate.ts'

/** 构造一行 CLI assistant 事件。 */
function assistantLine(blocks: unknown[]): string {
  return JSON.stringify({ type: 'assistant', message: { content: blocks } })
}

describe('thinking → reasoning 块', () => {
  it('读 `thinking` 字段(实测的 CLI 字段名),而不是 text', () => {
    const t = new CodebuddyTranslator()
    const { chunks } = t.push(assistantLine([
      { type: 'thinking', thinking: 'Very simple question. No tools needed.', signature: 'sig' },
    ]))
    const kinds = chunks.map((c) => c.type)
    expect(kinds).toContain('block-start')
    const start = chunks.find((c) => c.type === 'block-start')
    expect(start && 'blockType' in start && start.blockType).toBe('reasoning')
    const delta = chunks.find((c) => c.type === 'text-delta')
    expect(delta && 'text' in delta && delta.text).toBe('Very simple question. No tools needed.')
    const end = chunks.find((c) => c.type === 'block-end')
    expect(end && 'block' in end && end.block).toEqual({
      type: 'reasoning',
      text: 'Very simple question. No tools needed.',
    })
  })

  it('兼容 text 字段(防 CLI 版本差异)', () => {
    const t = new CodebuddyTranslator()
    const { chunks } = t.push(assistantLine([{ type: 'thinking', text: 'legacy field' }]))
    const delta = chunks.find((c) => c.type === 'text-delta')
    expect(delta && 'text' in delta && delta.text).toBe('legacy field')
  })

  it('空 thinking 不产出任何块', () => {
    const t = new CodebuddyTranslator()
    const { chunks } = t.push(assistantLine([{ type: 'thinking', thinking: '' }]))
    expect(chunks).toEqual([])
  })
})

describe('真实事件序列:思考→文本→工具交替', () => {
  it('全链路产出 reasoning + text + tool/call 三类', () => {
    const t = new CodebuddyTranslator()
    const lines = [
      assistantLine([
        { type: 'thinking', thinking: 'The user wants me to echo hi.' },
        { type: 'text', text: '好的,我来执行。' },
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'echo hi' } },
      ]),
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'hi' }] }] },
      }),
      assistantLine([
        { type: 'thinking', thinking: 'rtk 未安装,直接重试。' },
        { type: 'text', text: '执行完成。' },
      ]),
    ]
    let allChunks = []
    let steps = []
    for (const line of lines) {
      const r = t.push(line)
      allChunks.push(...r.chunks)
      steps.push(...r.toolSteps)
    }
    const reasoningDeltas = allChunks.filter(
      (c) => c.type === 'block-start' && 'blockType' in c && c.blockType === 'reasoning',
    )
    const textBlocks = allChunks.filter(
      (c) => c.type === 'block-end' && 'block' in c && (c.block as { type: string }).type === 'text',
    )
    expect(reasoningDeltas.length).toBe(2)
    expect(textBlocks.length).toBe(2)
    expect(steps.filter((s) => s.kind === 'tool/call').length).toBe(1)
    expect(steps.filter((s) => s.kind === 'tool/result').length).toBe(1)
  })
})
