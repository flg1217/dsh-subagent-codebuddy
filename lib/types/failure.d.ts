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
/** 归一化后的失败分类。 */
export interface CodebuddyFailure {
    /** 分类(quota/auth/model_service/network/empty_model_response/… )。 */
    category: string;
    /** 中文一行原因(面向对话中的中断提示)。 */
    reason: string;
    /** 是否值得恢复会话续跑(网络/模型服务等瞬时故障为 true)。 */
    retryable: boolean;
    /** 服务端 HTTP 状态码(429 等;有则带)。 */
    statusCode?: number;
    /** CLI 业务错误码(14003 请求频率超限、14001 额度耗尽 等)。 */
    bizCode?: number;
    /** 原始错误消息(截断留存,供排查)。 */
    detail?: string;
    /** 子分类(quota_request_limit/quota_balance_exhausted/…)。 */
    subcategory?: string;
}
/**
 * 任务结局是否代表失败中断(SUCCESS/PARTIAL_SUCCESS/CANCELLED 不算)。
 * `codebuddy.ai/outcome` 成功时也会写入(SUCCESS),不能见字段就报错。
 */
export declare function isFailureOutcome(outcome: unknown): outcome is string;
/**
 * 解析 CodeBuddy 失败上报。
 * @param raw - errorMessage(JSON 串或纯文本);可为空。
 * @param rpcCode - JSON-RPC 错误码(仅当 raw 无法给出分类时兜底)。
 * @param outcome - `codebuddy.ai/outcome` 任务结局(FAILED_MODEL_REQUEST 等;可选)。
 * @returns 分类结果;raw 为空且 rpcCode 未知时为 undefined。
 */
export declare function parseCodebuddyFailure(raw: string | undefined, rpcCode?: number, outcome?: string): CodebuddyFailure | undefined;
/**
 * 任意异常 → 失败分类(用于 ACP 请求失败路径)。
 * AcpRpcError 的 code/data 与 message 都参与判定。
 * @param error - 捕获到的异常。
 * @returns 分类结果(普通异常归 unknown,原文进 detail)。
 */
export declare function failureOfError(error: unknown): CodebuddyFailure;
/**
 * 组装一行中断原因:`分类原因——原始消息(category=…;httpStatus=…;bizCode=…)`。
 * @param failure - 分类结果。
 * @param suffix - 追加到末尾的附加证据(如 stderr 尾部)。
 * @returns 单行文本。
 */
export declare function formatFailureLine(failure: CodebuddyFailure, suffix?: string): string;
