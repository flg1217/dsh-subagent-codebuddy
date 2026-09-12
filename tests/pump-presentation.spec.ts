/**
 * 回放工具的 presentationMeta 投影回归:
 * 缺失 meta 必须给 `{}`(无损 JSON)——返回 undefined 会被 dsh 工具框架判
 * INVALID_TOOL_OUTPUT,把真实工具结果整个吞掉(实测:委托工具的子代理输出
 * 因此变成 "returned invalid output")。
 */
import { describe, expect, it } from 'vitest'
import { replayPresentationMeta } from '../src/pump.ts'

describe('replayPresentationMeta', () => {
  it('无 meta / null / 非对象 → 空对象(可快照)', () => {
    expect(replayPresentationMeta({ blocks: [] })).toEqual({})
    expect(replayPresentationMeta({ blocks: [], meta: undefined })).toEqual({})
    expect(replayPresentationMeta({ blocks: [], meta: null })).toEqual({})
    expect(replayPresentationMeta({ blocks: [], meta: 'text' })).toEqual({})
    expect(replayPresentationMeta({ blocks: [], meta: ['path'] })).toEqual({})
    expect(replayPresentationMeta(undefined)).toEqual({})
  })

  it('显式 meta 对象原样透传(图片路径等)', () => {
    expect(replayPresentationMeta({ blocks: [], meta: { path: 'design/a.png' } })).toEqual({ path: 'design/a.png' })
  })
})
