/**
 * CodeBuddy print 模式 stream-json 翻译器。
 *
 * CodeBuddy `-p --output-format stream-json` 按行输出完整事件,事件类型:
 * - `system`(init/status):会话初始化信息,忽略;
 * - `file-history-snapshot`:文件快照,忽略;
 * - `assistant`:完整 assistant 消息,content 块含
 *   `thinking` / `text` / `tool_use`(name,id,input);
 * - `user`:工具结果消息,content 块含 `tool_result`(tool_use_id,is_error,content);
 * - `result`:最终结果(subtype success/error,is_error,usage,permission_denials)。
 *
 * 翻译策略(对齐 llm-agy/translate.ts):
 * - thinking → reasoning 块(非空时);
 * - text → text 块(block-start/text-delta/block-end);
 * - tool_use → 会话 tool/call 事件(由调用方 append);
 * - user 行 → 会话 tool/result 事件;
 * - result.is_error → 携带执行反馈文本 + error finish。
 * @module subagent-codebuddy/translate
 */
import type { StreamChunk } from '@deepseek-ai/dsh-llm';
/** 解析后的工具步骤,供调用方 append 到子代理会话。 */
export interface ToolStep {
    readonly kind: 'tool/call' | 'tool/result';
    readonly callId: string;
    readonly name?: string;
    readonly argumentsJson?: string;
    readonly outputText?: string;
    readonly isError?: boolean;
}
/** 一行 stream-json 的翻译结果。 */
export interface PushResult {
    /** 需要 yield 给上游的流块。 */
    chunks: StreamChunk[];
    /** 需要 append 到子代理会话的工具事件。 */
    toolSteps: ToolStep[];
}
/** 最近执行步骤反馈(异常时主代理可见)。 */
export interface RecentStep {
    readonly callId: string;
    readonly toolName: string;
    readonly args: string;
    status: 'running' | 'OK' | 'FAILED';
    message?: string;
}
export declare class CodebuddyTranslator {
    private nextIndex;
    private _resultError;
    private _usage;
    private readonly recent;
    /** 已收到的执行错误(CodeBuddy result.is_error)。 */
    get resultError(): string | undefined;
    /** 最近执行步骤(前 8 步,异常反馈用)。 */
    get recentSteps(): readonly RecentStep[];
    private pushText;
    private pushReasoning;
    /** 逐行处理 stream-json;调用方逐行 push,流结束后调用 end() 收尾。 */
    push(line: string): PushResult;
    /** 流结束:产出 usage + finish。 */
    end(): StreamChunk[];
}
