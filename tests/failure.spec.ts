/**
 * 失败分类测试:CodeBuddy 的错误 JSON / JSON-RPC 码 → 可读中文原因与
 * 可重试性(配额/认证不重试,网络/模型服务瞬时故障保持续跑)。
 */
import { describe, expect, it } from 'vitest'
import { AcpRpcError } from '../src/acp.ts'
import { failureOfError, formatFailureLine, isFailureOutcome, parseCodebuddyFailure } from '../src/failure.ts'

/** CLI 实际形态:`JSON.stringify({code, message, data:{category,subcategory,statusCode,code}})`。 */
function errorJson(data: Record<string, unknown>, message = 'err', code = -32003): string {
  return JSON.stringify({ code, message, data })
}

describe('parseCodebuddyFailure:分类与原因', () => {
  it('配额限流(14003/429/quota_request_limit)→ 限流原因,不可重试', () => {
    const failure = parseCodebuddyFailure(errorJson(
      { category: 'quota', subcategory: 'quota_request_limit', statusCode: 429, code: 14003 },
      'Quota exceeded: too many requests',
    ))
    expect(failure).toBeDefined()
    expect(failure!.category).toBe('quota')
    expect(failure!.reason).toContain('限流')
    expect(failure!.retryable).toBe(false)
    expect(failure!.statusCode).toBe(429)
    expect(failure!.bizCode).toBe(14003)
    expect(failure!.detail).toContain('Quota exceeded')
  })

  it('额度耗尽(quota_balance_exhausted)→ 额度原因', () => {
    const failure = parseCodebuddyFailure(errorJson(
      { category: 'quota', subcategory: 'quota_balance_exhausted', statusCode: 402, code: 14001 },
    ))
    expect(failure!.reason).toContain('额度已用尽')
    expect(failure!.retryable).toBe(false)
  })

  it('认证失败 → 登录原因,不可重试', () => {
    const failure = parseCodebuddyFailure(errorJson({ category: 'auth', statusCode: 401 }, 'unauthorized', -32000))
    expect(failure!.category).toBe('auth')
    expect(failure!.reason).toContain('登录')
    expect(failure!.retryable).toBe(false)
  })

  it('模型服务异常 → 可重试', () => {
    const failure = parseCodebuddyFailure(errorJson({ category: 'model_service', statusCode: 503 }, 'overloaded', -32004))
    expect(failure!.category).toBe('model_service')
    expect(failure!.retryable).toBe(true)
  })

  it('纯文本 errorMessage(无 JSON)→ 原样进 detail,不可重试', () => {
    const failure = parseCodebuddyFailure('敏感内容被拦截')
    expect(failure!.category).toBe('unknown')
    expect(failure!.detail).toBe('敏感内容被拦截')
    expect(failure!.retryable).toBe(false)
  })

  it('仅 JSON-RPC 码(-32001 网络)→ 可重试', () => {
    const failure = parseCodebuddyFailure(undefined, -32001)
    expect(failure!.category).toBe('network')
    expect(failure!.retryable).toBe(true)
  })

  it('空输入 → undefined', () => {
    expect(parseCodebuddyFailure(undefined)).toBeUndefined()
    expect(parseCodebuddyFailure('')).toBeUndefined()
  })
})

describe('parseCodebuddyFailure:displayMsg 与 outcome', () => {
  it('displayMsg 中文优先(真实探针形态:模型不可用)→ 用官方文案', () => {
    const failure = parseCodebuddyFailure(JSON.stringify({
      code: -32603,
      message: 'Internal error',
      data: {
        statusCode: 400,
        code: 11102,
        category: 'internal',
        displayMsg: { en: 'The requested model is not available.', zh: '当前模型不可用，请切换其他模型后重试。' },
        details: '400 model [x] service info not found',
      },
    }))
    expect(failure!.reason).toBe('当前模型不可用，请切换其他模型后重试。')
    expect(failure!.category).toBe('internal')
    expect(failure!.bizCode).toBe(11102)
    expect(failure!.retryable).toBe(false)
  })

  it('无 displayMsg 时业务码兜底(11102)', () => {
    const failure = parseCodebuddyFailure(errorJson({ category: 'internal', code: 11102 }, 'Internal error', -32603))
    expect(failure!.reason).toContain('模型不可用')
  })

  it('outcome=REFUSED_OR_BLOCKED(无错误 JSON)→ 拦截原因', () => {
    const failure = parseCodebuddyFailure(undefined, undefined, 'REFUSED_OR_BLOCKED')
    expect(failure!.category).toBe('refused_or_blocked')
    expect(failure!.reason).toContain('拦截')
    expect(failure!.retryable).toBe(false)
  })

  it('isFailureOutcome:SUCCESS/PARTIAL_SUCCESS/CANCELLED 不算失败', () => {
    expect(isFailureOutcome('SUCCESS')).toBe(false)
    expect(isFailureOutcome('PARTIAL_SUCCESS')).toBe(false)
    expect(isFailureOutcome('CANCELLED')).toBe(false)
    expect(isFailureOutcome('FAILED_MODEL_REQUEST')).toBe(true)
    expect(isFailureOutcome('REFUSED_OR_BLOCKED')).toBe(true)
    expect(isFailureOutcome(undefined)).toBe(false)
  })
})

describe('failureOfError:异常 → 分类', () => {
  it('AcpRpcError 带 data → 走 JSON 分类', () => {
    const error = new AcpRpcError(-32003, 'ACP Quota exceeded', { category: 'quota', subcategory: 'quota_request_limit', statusCode: 429, code: 14003 })
    const failure = failureOfError(error)
    expect(failure.category).toBe('quota')
    expect(failure.reason).toContain('限流')
    expect(failure.retryable).toBe(false)
  })

  it('无结构异常(进程退出/超时)→ 保持可重试', () => {
    const failure = failureOfError(new Error('ACP 进程已退出'))
    expect(failure.category).toBe('unknown')
    expect(failure.retryable).toBe(true)
    expect(failure.detail).toContain('ACP 进程已退出')
  })
})

describe('formatFailureLine:单行原因', () => {
  it('原因 + 证据元信息 + stderr 尾巴', () => {
    const failure = parseCodebuddyFailure(errorJson(
      { category: 'quota', subcategory: 'quota_request_limit', statusCode: 429, code: 14003 },
      'Quota exceeded',
    ))
    const line = formatFailureLine(failure, ';stderr: rate limited')
    expect(line).toContain('限流')
    expect(line).toContain('category=quota')
    expect(line).toContain('httpStatus=429')
    expect(line).toContain('bizCode=14003')
    expect(line).toContain(';stderr: rate limited')
  })
})
