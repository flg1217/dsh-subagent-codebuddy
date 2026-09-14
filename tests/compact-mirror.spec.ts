/**
 * 镜像 CodeBuddy CLI 自己的压缩到 dsh:
 * - 只认 CLI 会话文件里新增的 `type:"summary"` + `providerData.source==='periodic'`;
 * - 追加一组与 dsh 原生压缩同形的事件(start → summary → replace checkpoint → end),
 *   摘要文本照抄 CLI 原文,**不调模型、不消耗 token**;
 * - 首次见到会话时游标直接跳到文件末尾(不回放历史压缩);
 * - 切点必须工具配对平衡,且已有未闭合事务时不再开一个。
 */
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { ConversationStore } from '../src/conversations.ts'
import { registerCompactMirror } from '../src/compact-mirror.ts'
import { projectSlug } from '../src/native-session.ts'

const CWD = 'D:\\Web\\demo'
const SESSION_ID = 'session-mirror-1'
const ACP_ID = 'acp-mirror-1'

let baseDir = ''
let summaryFile = ''

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'cb-mirror-'))
  summaryFile = join(baseDir, projectSlug(CWD), `${ACP_ID}.jsonl`)
})

interface Appended {
  type: string
  data: Record<string, unknown>
  surfaceOp?: unknown
  sourceEventSeqs?: readonly number[]
}

/** 一条 surface 事件(只保留镜像用得到的字段)。 */
interface FakeEvent {
  seq: number
  type: string
  toolCalls?: number
  /** 标记为压缩生命周期事件(用于"已有未闭合事务"用例)。 */
  lifecycle?: 'start' | 'end'
}

interface Harness {
  appended: Appended[]
  infos: string[]
  warns: string[]
  fire: (turn?: number) => Promise<unknown>
}

interface HarnessOptions {
  events: FakeEvent[]
  surface: number[]
  nodes: Array<{ seq: number; tokens: number; heuristicTokens: number }>
  totalTokens: number
  /** surface 自身计价(默认与 totalTokens 相同)。 */
  surfaceTokens?: number
  provider?: string
  store?: ConversationStore
}

/** 把一条 FakeEvent 转成镜像读到的形状。 */
function asEvent(event: FakeEvent): {
  type: string
  seq: number
  data: { message: { content: Array<{ type: string }> } }
} {
  return {
    type: event.lifecycle === 'start' ? 'compaction/start'
      : event.lifecycle === 'end' ? 'compaction/end'
        : event.type,
    seq: event.seq,
    data: { message: { content: Array.from({ length: event.toolCalls ?? 0 }, () => ({ type: 'tool-call' })) } },
  }
}

/** 造一个假 ctx + 假 session;`fire` 触发一次 pre-step。 */
function makeHarness(options: HarnessOptions): Harness {
  const appended: Appended[] = []
  const infos: string[] = []
  const warns: string[] = []
  const bySeq = new Map(options.events.map(event => [event.seq, event]))
  let handler: ((payload: unknown, next: () => Promise<unknown>) => Promise<unknown>) | undefined

  const session = {
    id: SESSION_ID,
    header: { cwd: CWD },
    surface: { nodes: options.surface },
    requestHeader: () => ({ config: { provider: options.provider ?? 'codebuddy', model: 'deepseek-v4.1-flash' } }),
    snapshotEvents: () => options.events.map(asEvent),
    eventAt: (seq: number) => {
      const event = bySeq.get(seq)
      return event === undefined ? undefined : asEvent(event)
    },
    append: (type: string, data: unknown, opts?: { surfaceOp?: unknown; sourceEventSeqs?: readonly number[] }) => {
      appended.push({ type, data: data as Record<string, unknown>, surfaceOp: opts?.surfaceOp, sourceEventSeqs: opts?.sourceEventSeqs })
      return { seq: appended.length }
    },
  }

  const ctx = {
    on: (event: string, cb: typeof handler) => {
      if (event === 'agent/pre-step') handler = cb
    },
    get: (key: string) => (key === 'tokenMeter'
      ? {
          measure: () => ({
            totalTokens: options.totalTokens,
            surfaceTokens: options.surfaceTokens ?? options.totalTokens,
            nodes: options.nodes,
          }),
        }
      : undefined),
    logger: {
      info: (message: string) => { infos.push(message) },
      warn: (message: string) => { warns.push(message) },
    },
  } as unknown as Context

  const store = options.store ?? new ConversationStore(null)
  store.set(SESSION_ID, { acpId: ACP_ID, sentCount: 1 })

  registerCompactMirror({ ctx, conversations: store, providerName: 'codebuddy', nativeBaseDir: baseDir })

  return {
    appended,
    infos,
    warns,
    fire: async (turn = 7) => await handler!({ agent: { session }, turn }, async () => 'NEXT'),
  }
}

/** 写一条 CLI 会话记录(默认覆盖整个文件)。 */
function writeRecord(record: unknown, options: { append?: boolean } = {}): void {
  mkdirSync(join(baseDir, projectSlug(CWD)), { recursive: true })
  const line = `${JSON.stringify(record)}\n`
  if (options.append === true) appendFileSync(summaryFile, line)
  else writeFileSync(summaryFile, line)
}

/** 一条 CLI 自己压出来的摘要记录。 */
function periodicSummary(text: string): unknown {
  return { id: 's-1', timestamp: 1, type: 'summary', summary: text, providerData: { source: 'periodic' } }
}

/** 最小可镜像 surface(3 个节点 → 够选出一段头部区间)。 */
const MINIMAL = {
  events: [
    { seq: 1, type: 'user/message' },
    { seq: 2, type: 'assistant/message' },
    { seq: 3, type: 'tool/result' },
  ],
  surface: [1, 2, 3],
  nodes: [1, 2, 3].map(seq => ({ seq, tokens: 100, heuristicTokens: 100 })),
  totalTokens: 300,
}

describe('registerCompactMirror:把 CLI 的压缩镜像成 dsh 压缩事务', () => {
  it('追加 start → summary → replace checkpoint → end,摘要照抄 CLI 原文', async () => {
    const harness = makeHarness({
      events: [
        { seq: 1, type: 'user/message' },
        { seq: 2, type: 'assistant/message' },
        { seq: 3, type: 'user/message' },
      ],
      surface: [1, 2, 3],
      nodes: [1, 2, 3].map(seq => ({ seq, tokens: 100, heuristicTokens: 100 })),
      totalTokens: 300,
    })
    // 先跑一次让游标落到 0(此时文件还不存在),再写 CLI 的压缩记录。
    await harness.fire()
    writeRecord(periodicSummary('CLI 自己的摘要原文'))

    expect(await harness.fire()).toBe('NEXT')
    expect(harness.appended.map(entry => entry.type))
      .toEqual(['compaction/start', 'compaction/summary', 'user/message', 'compaction/end'])

    const [start, summary, checkpoint, end] = harness.appended
    const compactionId = start!.data['compactionId']
    expect(start!.data['turn']).toBe(7)
    expect(summary!.data['compactionId']).toBe(compactionId)
    expect(summary!.data['summary']).toEqual([{ type: 'text', text: 'CLI 自己的摘要原文' }])
    // 零 token 的证据:摘要事件未标 llmStreamCall(类型上即"非本上下文 LLM 缝的调用")。
    expect(summary!.data['llmStreamCall']).toBeUndefined()
    expect(summary!.data['rawOutput']).toBeUndefined()
    expect(summary!.data['provider']).toBe('codebuddy')
    // checkpoint 必须带 replace + 插件来源标记,UI 才认它是压缩卡。
    expect(checkpoint!.data['source']).toEqual({ kind: 'plugin', plugin: 'compact', compactionId })
    expect(checkpoint!.surfaceOp).toEqual({ op: 'replace', start: 1, end: 2 })
    expect(JSON.stringify(checkpoint!.data['content'])).toContain('automatically generated checkpoint')
    expect(end!.data['compactionId']).toBe(compactionId)
    expect(harness.infos.some(message => message.includes('未消耗 token'))).toBe(true)
  })

  it('切点推到工具配对平衡处(不切断 tool-call / tool-result)', async () => {
    const harness = makeHarness({
      events: [
        { seq: 1, type: 'user/message' },
        { seq: 2, type: 'assistant/message', toolCalls: 1 },
        { seq: 3, type: 'tool/result' },
        { seq: 4, type: 'user/message' },
        { seq: 5, type: 'assistant/message', toolCalls: 1 },
        { seq: 6, type: 'tool/result' },
      ],
      surface: [1, 2, 3, 4, 5, 6],
      nodes: [1, 2, 3, 4, 5, 6].map(seq => ({ seq, tokens: 10, heuristicTokens: 10 })),
      totalTokens: 60,
    })
    await harness.fire()
    writeRecord(periodicSummary('s'))
    await harness.fire()

    const summary = harness.appended.find(entry => entry.type === 'compaction/summary')
    // 尾部本来从 seq5 开始,但 5 带 tool-call、6 是它的结果 → 切点推到 seq5 之前。
    expect(summary?.data['shadowedSeqs']).toEqual([1, 2, 3, 4])
    expect(summary?.data['shadowedRange']).toEqual({ start: 1, end: 4 })
    expect(summary?.data['shadowedTokenCount']).toBe(40)
  })

  it('首次见到会话时跳到文件末尾:不回放历史压缩', async () => {
    writeRecord(periodicSummary('很久以前压的'))
    const harness = makeHarness(MINIMAL)
    expect(await harness.fire()).toBe('NEXT')
    expect(harness.appended).toEqual([])
  })

  it('只认 periodic:种子首条(initial-user-message)不算压缩', async () => {
    writeRecord({ id: 's-0', timestamp: 1, type: 'summary', summary: 'seed', providerData: { source: 'initial-user-message' } })
    const harness = makeHarness(MINIMAL)
    await harness.fire()
    expect(harness.appended).toEqual([])

    writeRecord(periodicSummary('真压缩'), { append: true })
    await harness.fire()
    expect(harness.appended.map(entry => entry.type))
      .toEqual(['compaction/start', 'compaction/summary', 'user/message', 'compaction/end'])
  })

  it('尾部残行(还没写完的 JSON)不消费,补全后才镜像', async () => {
    const harness = makeHarness(MINIMAL)
    await harness.fire()
    writeRecord(periodicSummary('第一条'))
    const second = JSON.stringify(periodicSummary('第二条'))
    appendFileSync(summaryFile, second.slice(0, 20))
    await harness.fire()
    // 只镜像了完整的那条;残行被留在游标之后。
    const mirrored = harness.appended.filter(entry => entry.type === 'compaction/summary')
    expect(mirrored).toHaveLength(1)
    expect(mirrored[0]!.data['summary']).toEqual([{ type: 'text', text: '第一条' }])

    appendFileSync(summaryFile, `${second.slice(20)}\n`)
    await harness.fire()
    const all = harness.appended.filter(entry => entry.type === 'compaction/summary')
    expect(all).toHaveLength(2)
    expect(all[1]!.data['summary']).toEqual([{ type: 'text', text: '第二条' }])
  })

  it('非 codebuddy 路由 → 不镜像', async () => {
    const harness = makeHarness({ ...MINIMAL, provider: 'cpa' })
    await harness.fire()
    writeRecord(periodicSummary('s'))
    await harness.fire()
    expect(harness.appended).toEqual([])
  })

  it('已有未闭合的压缩事务 → 不再开一个(dsh 日志不变量禁止嵌套)', async () => {
    const harness = makeHarness({
      ...MINIMAL,
      events: [{ seq: 1, type: 'user/message' }, { seq: 2, type: 'compaction', lifecycle: 'start' }],
    })
    await harness.fire()
    writeRecord(periodicSummary('s'))
    await harness.fire()
    expect(harness.appended).toEqual([])
  })

  it('读会话映射抛错 → 只记日志,回合照常继续', async () => {
    const store = new ConversationStore(null)
    store.set(SESSION_ID, { acpId: ACP_ID, sentCount: 1 })
    Object.defineProperty(store, 'get', { value: () => { throw new Error('boom') } })
    const harness = makeHarness({ ...MINIMAL, store })
    expect(await harness.fire()).toBe('NEXT')
    expect(harness.appended).toEqual([])
    expect(harness.warns.some(message => message.includes('镜像 CLI 压缩失败'))).toBe(true)
  })
})
