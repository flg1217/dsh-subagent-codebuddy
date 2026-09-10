/**
 * 原生会话转换器测试:dsh 消息 → CodeBuddy 记录映射、id/slug 形态、
 * 文件写入与追加。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Message } from '@deepseek-ai/dsh-llm'
import {
  appendConversationRecords,
  conversationFilePath,
  messagesToRecords,
  projectSlug,
  sessionMetaRecords,
  uuidv7,
  writeConversationFile,
} from '../src/native-session.ts'

function user(id: string, text: string): Message {
  return { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } as unknown as Message
}

function assistant(id: string, content: Message['content']): Message {
  return { id, role: 'assistant', content, source: { kind: 'model', provider: 'codebuddy', model: 'glm-5.3' } } as unknown as Message
}

function toolResult(id: string, callId: string, text: string): Message {
  return {
    id,
    role: 'user',
    content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }] }],
    source: { kind: 'tool', callId },
  } as unknown as Message
}

const context = { sessionId: 'sess-1', cwd: 'H:\\Projects\\demo' }

describe('uuidv7 / slug', () => {
  it('uuidv7 形态正确(版本 7、variant 10)', () => {
    const id = uuidv7()
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('projectSlug:盘符小写、分隔符与冒号转 -', () => {
    expect(projectSlug('H:\\Projects\\DeepseekHarness')).toBe('h-Projects-DeepseekHarness')
    expect(projectSlug('d:\\Web\\mofun_lighting_design')).toBe('d-Web-mofun_lighting_design')
    expect(projectSlug('/home/u/proj')).toBe('-home-u-proj')
  })

  it('conversationFilePath 组成 <base>/<slug>/<id>.jsonl', () => {
    const file = conversationFilePath('abc', 'H:\\Projects\\demo', 'C:/base')
    expect(file.replace(/\\/g, '/')).toBe('C:/base/h-Projects-demo/abc.jsonl')
  })
})

describe('messagesToRecords', () => {
  it('user/assistant 文本 → message 记录;parentId 串链', async () => {
    const records = await messagesToRecords([
      user('u1', '你好'),
      assistant('a1', [{ type: 'text', text: '你好,有什么可以帮你' }]),
    ], context)
    expect(records.map(r => r['type'])).toEqual(['message', 'message'])
    expect(records[0]).toMatchObject({ role: 'user', content: [{ type: 'input_text', text: '你好' }] })
    expect(records[1]).toMatchObject({ role: 'assistant', content: [{ type: 'output_text', text: '你好,有什么可以帮你' }] })
    expect(records[1]!['parentId']).toBe(records[0]!['id'])
    expect(records.every(r => (r as { sessionId?: string }).sessionId === 'sess-1')).toBe(true)
  })

  it('工具调用 → function_call;工具结果 → function_call_result(name 由先前调用解析)', async () => {
    const records = await messagesToRecords([
      user('u1', '跑个命令'),
      assistant('a1', [
        { type: 'tool-call', id: 'call_1', name: 'Bash', arguments: '{"command":"echo hi"}' },
      ] as unknown as Message['content']),
      toolResult('t1', 'call_1', 'hi'),
    ], context)
    expect(records.map(r => r['type'])).toEqual(['message', 'function_call', 'function_call_result'])
    expect(records[1]).toMatchObject({ callId: 'call_1', name: 'Bash', arguments: '{"command":"echo hi"}' })
    expect(records[2]).toMatchObject({
      callId: 'call_1',
      name: 'Bash',
      status: 'completed',
      output: { type: 'text', text: 'hi' },
    })
  })

  it('reasoning 块跳过;图片块转为 [图片] 文本', async () => {
    const records = await messagesToRecords([
      assistant('a1', [
        { type: 'reasoning', text: '思考内容' },
        { type: 'text', text: '正文' },
      ] as unknown as Message['content']),
      user('u2', ''), // 空文本消息跳过
    ], context)
    expect(records.length).toBe(1)
    expect(JSON.stringify(records)).not.toContain('思考内容')
    const withImage = await messagesToRecords([
      { id: 'u3', role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image', attachment: { attachmentId: 'x' } }], source: { kind: 'user' } } as unknown as Message,
    ], context)
    expect(JSON.stringify(withImage)).toContain('[图片]')
  })

  it('压缩 checkpoint(plugin 源的摘要用户消息)按用户消息转换、文本完整保留', async () => {
    const checkpoint = {
      id: 'cp1',
      role: 'user',
      content: [{
        type: 'text',
        text: 'This is an automatically generated checkpoint condensing an earlier span of the conversation.\n\n<summary>要点 A;要点 B</summary>',
      }],
      source: { kind: 'plugin' },
    } as unknown as Message
    const records = await messagesToRecords([checkpoint, user('u9', '压缩后的新问题')], context)
    expect(records.map(r => r['type'])).toEqual(['message', 'message'])
    expect(records[0]).toMatchObject({ role: 'user', content: [{ type: 'input_text' }] })
    expect(JSON.stringify(records[0])).toContain('condensing an earlier span')
    expect(JSON.stringify(records[0])).toContain('要点 A;要点 B')
    expect(records[1]).toMatchObject({ role: 'user' })
  })

  it('提供图片面时:图片写 blob 并以原生 image_blob_ref 进入记录', async () => {
    const blobsRoot = mkdtempSync(join(tmpdir(), 'cb-blobs-'))
    try {
      const records = await messagesToRecords([
        {
          id: 'u1',
          role: 'user',
          content: [{ type: 'text', text: '看图' }, { type: 'image', attachment: { attachmentId: 'a1' } }],
          source: { kind: 'user' },
        } as unknown as Message,
      ], context, {
        readImage: async () => ({ data: new Uint8Array([1, 2, 3, 4]), ref: { mediaType: 'image/png' } }),
        blobsRoot,
      })
      const content = records[0]!['content'] as Array<Record<string, unknown>>
      expect(content[0]).toMatchObject({ type: 'input_text', text: '看图' })
      const imageBlock = content.find(block => block['type'] === 'image_blob_ref')
      expect(imageBlock).toBeDefined()
      expect(imageBlock!['mime']).toBe('image/png')
      expect(imageBlock!['size']).toBe(4)
      const blobPath = String(imageBlock!['blob_path'])
      expect(blobPath.startsWith(blobsRoot)).toBe(true)
      expect(readFileSync(blobPath).length).toBe(4)
    } finally {
      rmSync(blobsRoot, { recursive: true, force: true })
    }
  })
})

describe('会话文件写入', () => {
  it('writeConversationFile:首行 session-meta,内容为 JSONL;append 追加', async () => {
    const base = mkdtempSync(join(tmpdir(), 'cb-native-'))
    try {
      const file = conversationFilePath('sess-9', 'H:\\Projects\\demo', base)
      const ctx2 = { sessionId: 'sess-9', cwd: 'H:\\Projects\\demo' }
      expect(sessionMetaRecords(ctx2)[0]).toMatchObject({ type: 'session-meta', sessionId: 'sess-9' })
      writeConversationFile(file, await messagesToRecords([user('u1', '历史')], ctx2), ctx2)
      const first = readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l) as { type: string })
      expect(first.map(r => r.type)).toEqual(['session-meta', 'message'])
      appendConversationRecords(file, await messagesToRecords([user('u2', '补充')], ctx2))
      const after = readFileSync(file, 'utf8').trim().split('\n')
      expect(after.length).toBe(3)
      expect(after[2]).toContain('补充')
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
