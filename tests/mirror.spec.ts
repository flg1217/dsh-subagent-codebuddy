/**
 * 子代理镜像测试:CodeBuddy 转录 → dsh 影子子会话。
 * - 影子会话创建(meta: parentSession/origin/delegationDepth);
 * - 转录逐条转换(消息/思考/工具广告+调用+结果);
 * - 未决工具在收尾时补错误结果;结构与严格 v2 关系校验一致。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertReleasedArtifactRelationships } from '@deepseek-ai/dsh-session-format-v0-to-v1'
import { agentIdFromOutput, SubagentMirror } from '../src/mirror.ts'
import { projectSlug } from '../src/native-session.ts'

interface Recorded {
  type: string
  seq: number
  time: number
  data: unknown
  surfaceOp?: unknown
  sourceEventSeqs?: readonly number[]
}

function makeFakeSessions(): {
  sessions: { create: (id?: unknown, options?: { meta?: Record<string, unknown> }) => { id: string; append: (t: string, d: unknown, o?: unknown) => { seq: number } } }
  events: Recorded[]
  created: Array<Record<string, unknown> | undefined>
} {
  const events: Recorded[] = []
  const created: Array<Record<string, unknown> | undefined> = []
  const shadow = {
    id: 'shadow-1',
    append: (type: string, data: unknown, opts?: { surfaceOp?: unknown; sourceEventSeqs?: readonly number[] }) => {
      events.push({
        type,
        seq: events.length,
        time: events.length + 1,
        data,
        ...(opts?.surfaceOp !== undefined ? { surfaceOp: opts.surfaceOp } : {}),
        ...(opts?.sourceEventSeqs !== undefined ? { sourceEventSeqs: opts.sourceEventSeqs } : {}),
      })
      return { seq: events.length - 1 }
    },
  }
  return {
    sessions: { create: (_id, options) => { created.push(options?.meta); return shadow } },
    events,
    created,
  }
}

/** 建临时 projects 树并返回写入路径。 */
function makeTree(): { root: string; cwd: string; acpSessionId: string; file: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'cb-mirror-'))
  const cwd = 'H:\\Projects\\demo'
  const acpSessionId = 'acp-1'
  const dir = join(root, projectSlug(cwd), acpSessionId, 'subagents')
  mkdirSync(dir, { recursive: true })
  return {
    root,
    cwd,
    acpSessionId,
    file: join(dir, 'agent-x.jsonl'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

const records = [
  { type: 'message', role: 'user', content: [{ type: 'input_text', text: '计算 2+3 等于几' }] },
  { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '我来算一下。' }] },
  { type: 'reasoning', rawContent: '思考:直接算', content: [] },
  { type: 'function_call', callId: 'call_1', name: 'Bash', arguments: '{"command":"echo 5"}' },
  { type: 'function_call_result', callId: 'call_1', name: 'Bash', status: 'completed', output: { type: 'text', text: '5' } },
  { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '答案是 5' }] },
]

function writeRecords(file: string, list: readonly unknown[]): void {
  writeFileSync(file, `${list.map(r => JSON.stringify(r)).join('\n')}\n`)
}

function validate(events: readonly Recorded[]): void {
  const artifact = {
    header: { version: 2 },
    inheritedEventCount: 0,
    events,
  }
  expect(() => assertReleasedArtifactRelationships(
    artifact as unknown as Parameters<typeof assertReleasedArtifactRelationships>[0],
    { stepEvents: new Set(['assistant/attempt']) },
  )).not.toThrow()
}

describe('agentIdFromOutput', () => {
  it('解析结果文本里的 Agent ID', () => {
    expect(agentIdFromOutput('5\n\n[Agent ID: agent-abc123]')).toBe('agent-abc123')
    expect(agentIdFromOutput('无 id')).toBeUndefined()
  })
})

describe('SubagentMirror', () => {
  it('建影子会话(带 lineage meta)+ 转录逐条转换 + 通过严格 v2 关系校验', async () => {
    const tree = makeTree()
    try {
      const { sessions, events, created } = makeFakeSessions()
      const mirror = new SubagentMirror({
        sessions: sessions as never,
        parentSessionId: 'parent-1',
        cwd: tree.cwd,
        acpSessionId: tree.acpSessionId,
        projectsRoot: tree.root,
        pollMs: 10_000, // 手动 syncOnce,不用定时器
      })
      mirror.start({ label: '计算任务', prompt: '计算 2+3 等于几', delegationDepth: 2 })
      expect(created[0]).toMatchObject({
        parentSession: 'parent-1',
        origin: 'subagent',
        delegationDepth: 2,
        cwd: tree.cwd,
      })
      // 转录文件在 start 之后出现,手动拉取一次。
      writeRecords(tree.file, records)
      await mirror.syncOnce()
      await mirror.finish('agent-x')

      expect(events[0]).toMatchObject({ type: 'subagent/descriptor' })
      expect(JSON.stringify(events[0]!.data)).toContain('计算任务')
      const types = events.map(e => e.type)
      expect(types).toContain('turn/start')
      expect(types).toContain('step/start')
      expect(types.indexOf('tool/call')).toBeGreaterThan(0)
      // 严格校验:广告(assistant/message 内嵌 tool-call)在 tool/call 之前。
      const adIndex = events.findIndex(e => e.type === 'assistant/message' && JSON.stringify(e.data).includes('"tool-call"'))
      expect(adIndex).toBeGreaterThan(0)
      expect(adIndex).toBeLessThan(types.indexOf('tool/call'))
      expect(types.at(-2)).toBe('step/end')
      expect(types.at(-1)).toBe('turn/end')
      expect(JSON.stringify(events)).toContain('答案是 5')
      validate(events)
    } finally {
      tree.cleanup()
    }
  })

  it('收尾时未决工具补错误结果(step/end 前无未决生命周期)', async () => {
    const tree = makeTree()
    try {
      const { sessions, events } = makeFakeSessions()
      const mirror = new SubagentMirror({
        sessions: sessions as never,
        parentSessionId: 'parent-1',
        cwd: tree.cwd,
        acpSessionId: tree.acpSessionId,
        projectsRoot: tree.root,
        pollMs: 10_000,
      })
      mirror.start({ label: '半途', prompt: '半途任务', delegationDepth: 1 })
      writeRecords(tree.file, records.slice(0, 4)) // 含 function_call,无 result
      await mirror.syncOnce()
      await mirror.finish()

      const lastResult = [...events].reverse().find(e => e.type === 'tool/result')
      expect(lastResult).toBeDefined()
      expect(JSON.stringify(lastResult!.data)).toContain('"isError":true')
      expect(events.at(-1)!.type).toBe('turn/end')
      validate(events)
    } finally {
      tree.cleanup()
    }
  })

  it('转录文件缺席:影子会话仍正常闭合', async () => {
    const tree = makeTree()
    try {
      const { sessions, events } = makeFakeSessions()
      const mirror = new SubagentMirror({
        sessions: sessions as never,
        parentSessionId: 'parent-1',
        cwd: tree.cwd,
        acpSessionId: tree.acpSessionId,
        projectsRoot: tree.root,
        pollMs: 10_000,
      })
      mirror.start({ label: '无文件', prompt: 'x', delegationDepth: 1 })
      await mirror.finish('missing-agent')
      expect(events.map(e => e.type)).toContain('subagent/descriptor')
      expect(events.at(-1)!.type).toBe('turn/end')
      validate(events)
    } finally {
      tree.cleanup()
    }
  })

  it('转录图片消息(image_blob_ref)→ dsh 图片块(attachment 入库,可预览)', async () => {
    const tree = makeTree()
    try {
      const { sessions, events } = makeFakeSessions()
      const blobDir = join(tree.root, 'blobs')
      mkdirSync(blobDir, { recursive: true })
      const blobPath = join(blobDir, 'img.png')
      writeFileSync(blobPath, Buffer.from([137, 80, 78, 71, 1, 2, 3]))
      const saved = []
      const mirror = new SubagentMirror({
        sessions: sessions as never,
        parentSessionId: 'parent-1',
        cwd: tree.cwd,
        acpSessionId: tree.acpSessionId,
        projectsRoot: tree.root,
        pollMs: 10_000,
        attachments: {
          saveImage: async (_data, mediaType) => { saved.push(mediaType); return { attachmentId: 'att-1', mediaType, bytes: 7, width: 1, height: 1 } },
        },
      })
      mirror.start({ label: '看图任务', prompt: '看看这张图', delegationDepth: 1 })
      writeRecords(tree.file, [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: '看看这张图' },
            { type: 'image_blob_ref', blob_path: blobPath, mime: 'image/png' },
          ],
        },
      ])
      await mirror.syncOnce()
      await mirror.finish()
      expect(saved).toEqual(['image/png'])
      const userEvent = events.find(e => e.type === 'user/message')
      const content = (userEvent!.data as { content: Array<Record<string, unknown>> }).content
      expect(content.some(block => block.type === 'image')).toBe(true)
      validate(events)
    } finally {
      tree.cleanup()
    }
  })
})

describe('SubagentMirror:任务工具桥接', () => {
  it('转录里的 TaskCreate/TaskUpdate → 影子会话 todo/write 整表事件', async () => {
    const tree = makeTree()
    try {
      const { sessions, events } = makeFakeSessions()
      const mirror = new SubagentMirror({
        sessions: sessions as never,
        parentSessionId: 'parent-1',
        cwd: tree.cwd,
        acpSessionId: tree.acpSessionId,
        projectsRoot: tree.root,
        pollMs: 10_000,
      })
      mirror.start({ label: '任务子代理', prompt: '分派任务', delegationDepth: 1 })
      writeRecords(tree.file, [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: '分派任务' }] },
        { type: 'function_call', callId: 'c1', name: 'TaskCreate', arguments: '{"subject":"子任务A"}' },
        { type: 'function_call_result', callId: 'c1', name: 'TaskCreate', status: 'completed', output: { type: 'text', text: 'Task #1 created successfully: 子任务A' } },
        { type: 'function_call', callId: 'c2', name: 'TaskUpdate', arguments: '{"taskId":"1","status":"completed"}' },
        { type: 'function_call_result', callId: 'c2', name: 'TaskUpdate', status: 'completed', output: { type: 'text', text: 'Updated task #1 status' } },
      ])
      await mirror.syncOnce()
      await mirror.finish()
      const todos = events
        .filter(entry => entry.type === 'todo/write')
        .map(entry => (entry.data as { todos: unknown }).todos)
      expect(todos.length).toBeGreaterThanOrEqual(2)
      expect(todos[0]).toEqual([{ content: '子任务A', status: 'pending' }])
      expect(todos.at(-1)).toEqual([{ content: '子任务A', status: 'completed' }])
      validate(events)
    } finally {
      tree.cleanup()
    }
  })
})

describe('SubagentMirror:工具结果图片', () => {
  it('转录里的图片文本 JSON → 影子 tool/result 转 image 块', async () => {
    const tree = makeTree()
    try {
      const { sessions, events } = makeFakeSessions()
      const saved: Array<{ mediaType: string; bytes: number }> = []
      const mirror = new SubagentMirror({
        sessions: sessions as never,
        parentSessionId: 'parent-1',
        cwd: tree.cwd,
        acpSessionId: tree.acpSessionId,
        projectsRoot: tree.root,
        pollMs: 10_000,
        attachments: {
          saveImage: async (data, mediaType) => {
            saved.push({ mediaType, bytes: data.byteLength })
            return { attachmentId: 'sha256:test', mediaType, bytes: data.byteLength, width: 1, height: 1 }
          },
        },
      })
      mirror.start({ label: '图片子代理', prompt: '读图', delegationDepth: 1 })
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
      const imageJson = JSON.stringify([{ type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } }])
      writeRecords(tree.file, [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: '读图' }] },
        { type: 'function_call', callId: 'c1', name: 'Read', arguments: '{"file_path":"a.png"}' },
        { type: 'function_call_result', callId: 'c1', name: 'Read', status: 'completed', output: { type: 'text', text: imageJson } },
      ])
      await mirror.syncOnce()
      await mirror.finish()
      const result = events.find(e => e.type === 'tool/result')
      const blocks = (result!.data as {
        message: { content: Array<{ content?: Array<Record<string, unknown>> }> }
      }).message.content[0]!.content ?? []
      expect(blocks.some(b => b['type'] === 'image')).toBe(true)
      expect(JSON.stringify(blocks).includes('data:image')).toBe(false)
      expect(saved).toEqual([{ mediaType: 'image/png', bytes: Buffer.from(png, 'base64').byteLength }])
      const call = events.find(e => e.type === 'tool/call')!
      expect((call.data as { name: string }).name).toBe('read_image')
      expect((result!.data as { meta?: { path?: string } }).meta).toEqual({ path: 'a.png' })
      validate(events)
    } finally {
      tree.cleanup()
    }
  })
})
