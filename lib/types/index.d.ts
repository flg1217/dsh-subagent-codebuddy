/**
 * CodeBuddy CLI 作为 dsh 子代理提供方(LLM 适配器架构)。
 *
 * 结构对齐 dsh-llm-agy:
 *  1. 注册 `codebuddy` LLM provider 路由(CodebuddyLlmAdapter)——每次
 *     子代理 LLM 调用 spawn `codebuddy -p --output-format stream-json`,
 *     翻译文本与工具步骤回 dsh;
 *  2. 挂载 `@deepseek-ai/dsh-tool-subagent` 实例(provider: spawn,
 *     backgroundMode: continuable)——子代理是 dsh 进程内 agent,
 *     会话可常驻、`send_message` 可续聊;推理由 CodeBuddy 完成。
 *
 * 与"ACP 直接子代理"方案的区别:
 * - 每个子代理是独立 dsh 会话,并行子代理互不干扰、可分别续聊;
 * - 每次调用把该子代理自己的完整历史序列化进 prompt(不依赖
 *   CodeBuddy 按 cwd 自动续上下文的存储,无跨任务串味);
 * - 子代理仍由 CodeBuddy 驱动其自带工具,步骤回传 dsh 会话事件。
 * @module subagent-codebuddy
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "subagent-codebuddy";
export declare const inject: string[];
export interface Config {
    /** 可执行文件,默认 `codebuddy`。 */
    command?: string;
    /** 子代理使用的 CodeBuddy 模型 ID,默认 `deepseek-v4-flash`。 */
    model?: string;
    /**
     * 传给 `--permission-mode` 的权限模式,默认 `bypassPermissions`
     * (子代理工具调用自动放行,不询问)。
     */
    permissionMode?: string;
    /** 追加的额外 CodeBuddy 参数。 */
    extraArgs?: string[];
    /** LLM provider 路由名,默认 `codebuddy`。 */
    providerName?: string;
    /** 工具名,默认 `subagent_codebuddy`。 */
    toolName?: string;
    /** 是否注册委派工具(默认开启)。 */
    registerSubagentTools?: boolean;
}
export declare const Config: z<Config>;
export declare function apply(ctx: Context, config: Config): void;
