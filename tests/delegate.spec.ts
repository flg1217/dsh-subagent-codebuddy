/**
 * 委托工具注册面的协议形状测试:
 * - `_codebuddy.ai/delegateToolsChanged` 的发射形状(方法/会话/工具映射/provider);
 * - 空列表短路;批量注册(pump 分批调用)不影响形状。
 */
import { describe, expect, it } from 'vitest'
import {
  announceDelegateTools,
  DELEGATE_TOOLS_CHANGED_METHOD,
  type DelegateToolSpec,
} from '../src/delegate.ts'

/** 最小工具描述符。 */
function spec(id: string, name: string): DelegateToolSpec {
  return {
    id,
    name,
    description: `desc ${id}`,
    inputSchema: { type: 'object', properties: { a: { type: 'string' } } },
  }
}

describe('announceDelegateTools:注册形状', () => {
  it('发出 delegateToolsChanged:方法/会话/工具映射/provider 全透传', async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    await announceDelegateTools(async (method, params) => {
      calls.push({ method, params })
      return {}
    }, 'acp-1', [spec('dsh_read', 'Dsh-read'), spec('dsh_grep', 'Dsh-grep')])

    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe(DELEGATE_TOOLS_CHANGED_METHOD)
    expect(calls[0]!.params['sessionId']).toBe('acp-1')
    expect(calls[0]!.params['changeType']).toBe('added')
    const tools = calls[0]!.params['tools'] as Array<Record<string, unknown>>
    expect(tools.map(tool => tool['id'])).toEqual(['dsh_read', 'dsh_grep'])
    expect(tools[0]!['name']).toBe('Dsh-read')
    expect(tools[0]!['description']).toBe('desc dsh_read')
    expect(tools[0]!['inputSchema']).toEqual({ type: 'object', properties: { a: { type: 'string' } } })
    expect(tools[0]!['provider']).toBe('dsh-subagent')
  })

  it('空列表短路:不发请求(分批注册的边界批不产生空帧)', async () => {
    let called = 0
    await announceDelegateTools(async () => { called += 1; return {} }, 'acp-1', [])
    expect(called).toBe(0)
  })

  it('分批注册:每批独立成帧,合并后即全量工具集', async () => {
    const calls: Array<Record<string, unknown>> = []
    await announceDelegateTools(async (_method, params) => {
      calls.push(params)
      return {}
    }, 'acp-1', [spec('dsh_a', 'A')])
    await announceDelegateTools(async (_method, params) => {
      calls.push(params)
      return {}
    }, 'acp-1', [spec('dsh_b', 'B'), spec('dsh_c', 'C')])
    const ids = calls.flatMap(params => (params['tools'] as Array<Record<string, unknown>>).map(tool => tool['id']))
    expect(ids).toEqual(['dsh_a', 'dsh_b', 'dsh_c'])
  })
})
