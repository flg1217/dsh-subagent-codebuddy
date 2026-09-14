/**
 * bridgeMode 设置解析优先级回归:用户层(表单)显式值优先,插件行配置只作兜底——
 * 旧的 OR 合成会让配置 delegate 一票否决表单里的 mcp(面板开了也切不回)。
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { registerCodebuddySettings } from '../src/settings.ts'

interface Harness {
  ctx: Context
  setUser: (values: Record<string, unknown>) => void
  entry: () => Record<string, unknown>
}

function makeHarness(): Harness {
  let user: Record<string, unknown> = {}
  let entry: Record<string, unknown> = {}
  const settingsFace = {
    installSection: (
      _owner: unknown, _ns: string, _schema: unknown,
      base: Record<string, unknown>,
      hooks: { setSource: (source: () => Record<string, unknown>) => void },
    ): void => {
      entry = base
      // 近似真实语义:resolved = base(组装层) ∪ user(用户层)。
      hooks.setSource(() => ({ ...base, ...user }))
    },
  }
  const ctx = {
    inject: (_deps: string[], fn: (injected: Context) => void): void => {
      fn({ get: (key: string): unknown => (key === 'settings' ? settingsFace : undefined) } as unknown as Context)
    },
    get: (): undefined => undefined,
  } as unknown as Context
  return { ctx, setUser: (values) => { user = values }, entry: () => entry }
}

function effective(userValues: Record<string, unknown>, configBridge: 'mcp' | 'delegate' | undefined): {
  bridgeMode: string
  entry: Record<string, unknown>
} {
  const h = makeHarness()
  const sectionOf = registerCodebuddySettings(h.ctx, { bridgeMode: configBridge } as never)
  h.setUser(userValues)
  return { bridgeMode: sectionOf().bridgeMode, entry: h.entry() }
}

describe('settings:bridgeMode 解析(表单优先,配置兜底)', () => {
  it('表单显式 mcp 覆盖配置 delegate(回归:配置一票否决已移除)', () => {
    expect(effective({ bridgeMode: 'mcp' }, 'delegate').bridgeMode).toBe('mcp')
  })

  it('表单显式 delegate 覆盖配置 mcp', () => {
    expect(effective({ bridgeMode: 'delegate' }, 'mcp').bridgeMode).toBe('delegate')
  })

  it('表单未设 → 用配置值', () => {
    expect(effective({}, 'delegate').bridgeMode).toBe('delegate')
    expect(effective({}, 'mcp').bridgeMode).toBe('mcp')
  })

  it('都未设 → 默认 mcp;entry(base)携带配置值供面板显示与回落', () => {
    expect(effective({}, undefined).bridgeMode).toBe('mcp')
    expect(effective({}, undefined).entry['bridgeMode']).toBe('mcp')
    expect(effective({}, 'delegate').entry['bridgeMode']).toBe('delegate')
  })
})
