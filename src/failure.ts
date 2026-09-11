/**
 * CodeBuddy 失败分类:把 CLI 的错误上报翻译成对话里可读的中断原因。
 *
 * CodeBuddy 在 ACP 上的失败上报有两条通道(实测 codebuddy.js 内部实现):
 * - `session/prompt` 结果:`errorMessage` 或 `_meta["codebuddy.ai/errorMessage"]`,
 *   内容是 `JSON.stringify({code: rpcCode, message, data:{category, subcategory,
 *   statusCode, code: bizCode, reason}})`;错误时 stopReason 统一回落
 *   `"refusal"`,只有解析这段 JSON 才知道真实原因;
 * - JSON-RPC error:`code`(-32003 配额 / -32004 模型服务 / -32001 网络 / …)
 *   与 `data`,由 AcpRpcError 携带。
 *
 * 分类值:`quota`(限流/配额) / `auth`(登录/授权) / `model_service`(模型服务) /
 * `network`(网络/网关) / `empty_model_response`(空流) / `cancelled` /
 * `internal` / `unknown`。
 * @module subagent-codebuddy/failure
 */

import { AcpRpcError } from './acp.js'

/** 归一化后的失败分类。 */
export interface CodebuddyFailure {
  /** 分类(quota/auth/model_service/network/empty_model_response/… )。 */
  category: string
  /** 中文一行原因(面向对话中的中断提示)。 */
  reason: string
  /** 是否值得恢复会话续跑(网络/模型服务等瞬时故障为 true)。 */
  retryable: boolean
  /** 服务端 HTTP 状态码(429 等;有则带)。 */
  statusCode?: number
  /** CLI 业务错误码(14003 请求频率超限、14001 额度耗尽 等)。 */
  bizCode?: number
  /** 原始错误消息(截断留存,供排查)。 */
  detail?: string
  /** 子分类(quota_request_limit/quota_balance_exhausted/…)。 */
  subcategory?: string
}

/** 配额子类 → 中文原因。 */
const QUOTA_REASONS: Readonly<Record<string, string>> = {
  quota_request_limit: '账号限流(请求频率超限)',
  quota_balance_exhausted: '账号额度已用尽',
  quota_active_session: '账号同时进行的会话数已满',
  quota_web_search: '联网搜索额度已用尽',
}

/** 业务码 → 分类(CLI 内部 10105/15001/14001-14018 一组配额码)。 */
const BIZ_CODE_CATEGORY: Readonly<Record<number, string>> = {
  10105: 'quota',
  15001: 'quota',
  14001: 'quota',
  14002: 'quota',
  14003: 'quota',
  14012: 'quota',
  14013: 'quota',
  14014: 'quota',
  14018: 'quota',
  14015: 'quota',
}

/** 非配额分类 → 中文原因。 */
const CATEGORY_REASONS: Readonly<Record<string, string>> = {
  auth: '登录态失效或无权访问(需重新登录 CodeBuddy 账号)',
  custom_model_auth: '自定义模型鉴权失败',
  model_service: '模型服务异常',
  network: '网络/网关异常',
  empty_model_response: '模型返回空流(服务端暂时不可用)',
  cancelled: '请求已取消',
  internal: 'CodeBuddy 内部错误',
}

/** `codebuddy.ai/outcome`(任务结局)→ 中文原因(仅当错误 JSON 无 displayMsg 时兜底)。 */
const OUTCOME_REASONS: Readonly<Record<string, string>> = {
  PERMISSION_DENIED: '权限被拒绝',
  CANCELLED: '请求已取消',
  REFUSED_OR_BLOCKED: '请求被拒绝或拦截(内容策略/风控)',
}

/** 业务码 → 中文原因(无 displayMsg 时的兜底;11102 = 账号无权使用该模型)。 */
const BIZ_CODE_REASONS: Readonly<Record<number, string>> = {
  11102: '模型不可用(账号无权使用该模型)',
  11140: '登录态失效或无权访问',
  11141: '登录态失效或无权访问',
  11142: '登录态失效或无权访问',
}

/** JSON-RPC 错误码 → 分类(来自 CLI 的 rl/rc/ru/rd/rp 常量)。 */
function categoryOfRpcCode(code: number | undefined): string | undefined {
  switch (code) {
    case -32003: return 'quota'
    case -32004: return 'model_service'
    case -32001: return 'network'
    case -32002: return 'cancelled'
    case -32010: return 'internal'
    default: return undefined
  }
}

/** 可重试分类(瞬时故障;配额/认证重试无意义)。 */
function isRetryableCategory(category: string): boolean {
  return category === 'network' || category === 'model_service' || category === 'empty_model_response'
}

/** 取 number 字段(非有限数则 undefined)。 */
function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 任务结局是否代表失败中断(SUCCESS/PARTIAL_SUCCESS/CANCELLED 不算)。
 * `codebuddy.ai/outcome` 成功时也会写入(SUCCESS),不能见字段就报错。
 */
export function isFailureOutcome(outcome: unknown): outcome is string {
  return typeof outcome === 'string'
    && (outcome.startsWith('FAILED_') || outcome === 'REFUSED_OR_BLOCKED' || outcome === 'PERMISSION_DENIED')
}

/**
 * 解析 CodeBuddy 失败上报。
 * @param raw - errorMessage(JSON 串或纯文本);可为空。
 * @param rpcCode - JSON-RPC 错误码(仅当 raw 无法给出分类时兜底)。
 * @param outcome - `codebuddy.ai/outcome` 任务结局(FAILED_MODEL_REQUEST 等;可选)。
 * @returns 分类结果;raw 为空且 rpcCode 未知时为 undefined。
 */
export function parseCodebuddyFailure(raw: string | undefined, rpcCode?: number, outcome?: string): CodebuddyFailure | undefined {
  const text = raw?.trim()
  if ((text === undefined || text.length === 0) && rpcCode === undefined && outcome === undefined) return undefined

  let message: string | undefined
  let display: string | undefined
  let category: string | undefined
  let statusCode: number | undefined
  let bizCode: number | undefined
  let subcategory: string | undefined
  if (text !== undefined && text.length > 0) {
    const parsed = tryParseObject(text)
    if (parsed === undefined) {
      // 纯文本错误(如敏感输入拦截的 safeMessage):没有分类信息,原样透出。
      message = text
    } else {
      if (typeof parsed['message'] === 'string') message = parsed['message']
      const data = parsed['data']
      if (data !== undefined && data !== null && typeof data === 'object' && !Array.isArray(data)) {
        const record = data as Record<string, unknown>
        if (typeof record['category'] === 'string') category = record['category']
        statusCode = numberField(record['statusCode'])
        bizCode = numberField(record['code'])
        if (typeof record['subcategory'] === 'string') subcategory = record['subcategory']
        if (typeof record['reason'] === 'string' && message === undefined) message = record['reason']
        // displayMsg 是 CLI 给界面的多语言文案(zh/en/zh-hant),中文优先。
        display = displayMessageOf(record['displayMsg'])
        if (typeof record['details'] === 'string' && record['details'].length > 0) {
          message = message !== undefined && message !== 'Internal error' ? message : record['details']
        }
      }
      rpcCode ??= numberField(parsed['code'])
    }
  }

  if (category === undefined && bizCode !== undefined) category = BIZ_CODE_CATEGORY[bizCode]
  category ??= categoryOfRpcCode(rpcCode)
  if (category === undefined && (outcome === 'PERMISSION_DENIED' || outcome === 'CANCELLED' || outcome === 'REFUSED_OR_BLOCKED')) {
    category = outcome === 'CANCELLED' ? 'cancelled' : outcome === 'PERMISSION_DENIED' ? 'permission_denied' : 'refused_or_blocked'
  }
  if (category === undefined) category = 'unknown'

  const reason = display
    ?? (category === 'quota'
      ? QUOTA_REASONS[subcategory ?? ''] ?? (subcategory !== undefined ? `账号受限(${subcategory})` : '账号受限(限流/配额不足)')
      : (bizCode !== undefined ? BIZ_CODE_REASONS[bizCode] : undefined)
        ?? CATEGORY_REASONS[category]
        ?? (outcome !== undefined ? OUTCOME_REASONS[outcome] : undefined)
        ?? '未知错误')

  return {
    category,
    reason,
    retryable: isRetryableCategory(category),
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(bizCode !== undefined ? { bizCode } : {}),
    ...(subcategory !== undefined ? { subcategory } : {}),
    ...(message !== undefined && message.length > 0 && message !== reason ? { detail: message } : {}),
  }
}

/** 从 displayMsg 对象里取中文(zh/zh-Hans/zh-hant),回退英文,再回退首个字符串。 */
function displayMessageOf(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const preferred = firstString(
    record['zh'], record['zh-Hans'], record['zh-hant'], record['zh-Hant'], record['en'], record['en-US'],
  )
  if (preferred !== undefined) return preferred
  return firstString(...Object.values(record))
}

/** 第一个非空字符串。 */
function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/** JSON.parse,非对象或解析失败返回 undefined。 */
function tryParseObject(text: string): Record<string, unknown> | undefined {
  if (!text.startsWith('{')) return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

/**
 * 任意异常 → 失败分类(用于 ACP 请求失败路径)。
 * AcpRpcError 的 code/data 与 message 都参与判定。
 * @param error - 捕获到的异常。
 * @returns 分类结果(普通异常归 unknown,原文进 detail)。
 */
export function failureOfError(error: unknown): CodebuddyFailure {
  if (error instanceof AcpRpcError) {
    const data = error.data
    const raw = data === undefined ? undefined : JSON.stringify({
      message: error.message,
      code: error.code,
      data,
    })
    const failure = parseCodebuddyFailure(raw, error.code)
    if (failure !== undefined && failure.category !== 'unknown') return failure
  }
  // 无结构信息的异常(进程退出/请求超时/协议错误):按历史语义恢复续跑。
  const message = error instanceof Error ? error.message : String(error)
  return { category: 'unknown', reason: '未知错误', retryable: true, detail: message }
}

/**
 * 组装一行中断原因:`分类原因——原始消息(category=…;httpStatus=…;bizCode=…)`。
 * @param failure - 分类结果。
 * @param suffix - 追加到末尾的附加证据(如 stderr 尾部)。
 * @returns 单行文本。
 */
export function formatFailureLine(failure: CodebuddyFailure, suffix?: string): string {
  const meta = [
    `category=${failure.category}`,
    failure.statusCode !== undefined ? `httpStatus=${failure.statusCode}` : '',
    failure.bizCode !== undefined ? `bizCode=${failure.bizCode}` : '',
  ].filter(part => part.length > 0).join(';')
  const detail = failure.detail !== undefined && failure.detail !== failure.reason
    ? `——${failure.detail.slice(0, 300)}`
    : ''
  const evidence = suffix !== undefined && suffix.length > 0 ? suffix : ''
  return `${failure.reason}${detail}(${meta})${evidence}`
}
