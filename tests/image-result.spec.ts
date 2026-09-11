/**
 * 读图工具结果的端到端落盘:CodeBuddy Read 返回 image_url data URI 时,
 * tool/result 必须落成 dsh 原生 image 块(saveImage → attachment ref),
 * 而不是把 base64 原样铺进文本;并仍通过官方关系校验。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { spawn } from 'node:child_process'
import { assertReleasedArtifactRelationships } from '@deepseek-ai/dsh-session-format-v0-to-v1'
import { asSpawnResult, autoHandshake, fakeAcpProc, message, toolCall, toolUpdate } from './fake-acp.ts'
import { makeRecordingAdapter } from './recording-fixture.ts'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn() }
})
const mockedSpawn = vi.mocked(spawn)

// 1x1 透明 PNG 的最小合法 base64
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const IMAGE_JSON = JSON.stringify([
  { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_B64}` } },
])

beforeEach(() => {
  mockedSpawn.mockReset()
})

describe('读图工具结果落盘为 image 块', () => {
  it('image_url data URI → saveImage 附件 + image 块,通过关系校验', async () => {
    mockedSpawn.mockImplementation(() => {
      const p = fakeAcpProc()
      autoHandshake(p)
      setTimeout(() => {
        p.update(message('读取图片'))
        p.update(toolCall('call_img', 'Read', { path: 'design.png' }))
        p.update(toolUpdate('call_img', 'completed', IMAGE_JSON))
        p.respond(p.requestLog().length, { stopReason: 'end_turn' })
      }, 5)
      return asSpawnResult(p)
    })
    const saved: Array<{ data: Uint8Array; mediaType: string }> = []
    const { adapter, events, seedTurnEnd } = makeRecordingAdapter({
      attachments: {
        saveImage: async (input) => {
          saved.push(input)
          return {
            attachmentId: 'sha256:test-image',
            mediaType: input.mediaType,
            bytes: input.data.byteLength,
            width: 1,
            height: 1,
          }
        },
      },
    })
    for await (const _ of adapter.stream({ model: 'glm-5.3', provider: 'codebuddy', sessionId: 's1', messages: [{ role: 'user', content: [{ type: 'text', text: '任务' }] }] } as never)) {
      /* drain */
    }
    seedTurnEnd()

    // saveImage 被调用且字节与 PNG 一致
    expect(saved).toHaveLength(1)
    expect(saved[0]!.mediaType).toBe('image/png')
    expect(saved[0]!.data.byteLength).toBeGreaterThan(0)

    // tool/result 的 content 含 image 块(attachment ref),不含 base64 文本
    const result = events.find(e => e.type === 'tool/result')
    expect(result).toBeDefined()
    const resultData = result!.data as { message: { content: Array<Record<string, unknown>> } }
    const toolResultBlock = resultData.message.content[0] as unknown as { type: string; content: Array<Record<string, unknown>> }
    expect(toolResultBlock.type).toBe('tool-result')
    const imageBlock = toolResultBlock.content.find(b => b['type'] === 'image')
    expect(imageBlock).toBeDefined()
    expect((imageBlock!['attachment'] as { attachmentId: string }).attachmentId).toBe('sha256:test-image')
    // 文本块不得包含 base64
    const textBlocks = toolResultBlock.content.filter(b => b['type'] === 'text')
    for (const t of textBlocks) {
      expect(String(t['text'])).not.toContain('iVBORw0KGgo')
    }

    // 与官方关系校验器同款断言(补全收尾后的全量事件)
    const full = {
      header: { version: 2, id: 's1', createdAt: 1, cwd: process.cwd(), isSeeded: false, delegationDepth: 1 },
      inheritedEventCount: 0,
      events: events.map((e, i) => ({ ...e, seq: i })),
    }
    expect(() => assertReleasedArtifactRelationships(full as never)).not.toThrow()
  })

  it('附件服务不可用时降级为文本提示,不抛错、不落 base64', async () => {
    mockedSpawn.mockImplementation(() => {
      const p = fakeAcpProc()
      autoHandshake(p)
      setTimeout(() => {
        p.update(toolCall('call_img2', 'Read', { path: 'design.png' }))
        p.update(toolUpdate('call_img2', 'completed', IMAGE_JSON))
        p.respond(p.requestLog().length, { stopReason: 'end_turn' })
      }, 5)
      return asSpawnResult(p)
    })
    const { adapter, events, seedTurnEnd } = makeRecordingAdapter() // 无 attachments
    for await (const _ of adapter.stream({ model: 'glm-5.3', provider: 'codebuddy', sessionId: 's1', messages: [{ role: 'user', content: [{ type: 'text', text: '任务' }] }] } as never)) {
      /* drain */
    }
    seedTurnEnd()
    const result = events.find(e => e.type === 'tool/result')
    const serialized = JSON.stringify(result!.data)
    expect(serialized).toContain('附件服务不可用')
    expect(serialized).not.toContain('iVBORw0KGgo')
  })
})
