/**
 * 工具面切换注入:路由在 CodeBuddy 与 dsh 原生之间切换时,pre-step 注入说明
 * (核心的 modelSwitchNotice 只报"模型变了",工具面差异由本插件补)。
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSwitchToolGuide } from '../src/tool-guide.ts'

type Listener = (...args: unknown[]) => unknown

/** 最小 ctx:只提供 on;暴露 emit 与 pre-step 处理器取用。 */
function makeCtx(): { ctx: Context; emit: (name: string, ...args: unknown[]) => void; prep: () => Listener } {
  const listeners = new Map<string, Listener[]>()
  const ctx = {
    on: (name: string, handler: Listener): (() => void) => {
      const list = listeners.get(name) ?? []
      list.push(handler)
      listeners.set(name, list)
      return () => { /* 测试不注销 */ }
    },
  } as unknown as Context
  return {
    ctx,
    emit: (name, ...args) => { for (const h of listeners.get(name) ?? []) h(...args) },
    prep: () => {
      const h = (listeners.get('agent/pre-step') ?? [])[0]
      if (h === undefined) throw new Error('pre-step 未注册')
      return h
    },
  }
}

const SESSION = { header: { id: 's1', cwd: process.cwd() } }
const AGENT = { session: SESSION }
const SIGNAL = new AbortController().signal

function userMsg(text: string): Record<string, unknown> {
  return { id: `u-${text}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

/** 跑一次 pre-step:next 给出基准 decision。 */
async function runPreStep(
  prep: () => Listener,
  payload: Record<string, unknown>,
  base: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return await prep()(payload, async () => base) as Record<string, unknown>
}

const BASE = (messages: unknown[]): Record<string, unknown> => ({ kind: 'enter', messages })
const inlineTexts = (decision: Record<string, unknown>): string[] =>
  (decision['messages'] as Array<{ content?: Array<{ text?: string }> }>)
    .flatMap(m => (m.content ?? []).map(c => c.text ?? ''))

describe('工具面切换注入(CodeBuddy ↔ dsh 原生)', () => {
  it('切到 codebuddy:注入"改用 dsh 桥工具"说明', async () => {
    const { ctx, emit, prep } = makeCtx()
    installModelSwitchToolGuide(ctx)
    emit('session/event', SESSION, { type: 'model/selection', data: { provider: 'codebuddy', model: 'deepseek-v4.1-flash' } })
    const d = await runPreStep(prep, { agent: AGENT, messages: [], signal: SIGNAL, step: 2 }, BASE([userMsg('hi')]))
    const texts = inlineTexts(d)
    expect(texts).toHaveLength(2)
    expect(texts[1]).toContain('CodeBuddy 桥')
    expect(texts[1]).toContain('mcp__dsh__')
  })

  it('切离 codebuddy(→ dsh 原生):注入"恢复原生工具、勿用 cli_"说明', async () => {
    const { ctx, emit, prep } = makeCtx()
    installModelSwitchToolGuide(ctx)
    emit('session/event', SESSION, { type: 'model/selection', data: { provider: 'codebuddy', model: 'm' } })
    emit('session/event', SESSION, { type: 'model/selection', data: { provider: 'sensenova', model: 'kimi-k3' } })
    const d = await runPreStep(prep, { agent: AGENT, messages: [], signal: SIGNAL, step: 2 }, BASE([userMsg('hi')]))
    const texts = inlineTexts(d)
    expect(texts).toHaveLength(2)
    expect(texts[1]).toContain('dsh 原生')
    expect(texts[1]).toContain('cli_')
  })

  it('与 CodeBuddy 无关的切换(原生模型之间):不注入', async () => {
    const { ctx, emit, prep } = makeCtx()
    installModelSwitchToolGuide(ctx)
    emit('session/event', SESSION, { type: 'model/selection', data: { provider: 'sensenova', model: 'kimi-k3' } })
    emit('session/event', SESSION, { type: 'model/selection', data: { provider: 'pixel', model: 'gpt-6-astra' } })
    const d = await runPreStep(prep, { agent: AGENT, messages: [], signal: SIGNAL, step: 2 }, BASE([userMsg('hi')]))
    expect(inlineTexts(d)).toHaveLength(1)
  })

  it('空步不注入、保留到下一步(注入不随空步丢失)', async () => {
    const { ctx, emit, prep } = makeCtx()
    installModelSwitchToolGuide(ctx)
    emit('session/event', SESSION, { type: 'model/selection', data: { provider: 'codebuddy', model: 'm' } })
    // 空步(step 1,无认领消息):跳过,待注入保留。
    const skipped = await runPreStep(prep, { agent: AGENT, messages: [], signal: SIGNAL, step: 1 }, BASE([]))
    expect(skipped['messages']).toHaveLength(0)
    // 下一步(有消息):注入生效。
    const d = await runPreStep(prep, { agent: AGENT, messages: [userMsg('next')], signal: SIGNAL, step: 2 }, BASE([userMsg('next')]))
    expect(inlineTexts(d)).toHaveLength(2)
    // 已消费:再下一步不再重复注入。
    const again = await runPreStep(prep, { agent: AGENT, messages: [userMsg('later')], signal: SIGNAL, step: 2 }, BASE([userMsg('later')]))
    expect(inlineTexts(again)).toHaveLength(1)
  })
})
