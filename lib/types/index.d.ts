/**
 * CodeBuddy CLI 作为 dsh 子代理提供方(ACP 驱动)。
 *
 * 结构对齐 dsh-llm-agy:插件自包含,动态挂载两个官方插件实例——
 *  1. `@deepseek-ai/dsh-subagent-acp`:注册名为 `codebuddy` 的
 *     ctx.subagents 提供方,每次委派 spawn 一个 `codebuddy --acp`
 *     子进程,按 ACP wire 驱动并收集结果;
 *  2. `@deepseek-ai/dsh-tool-subagent`:注册 `subagent_codebuddy`
 *     工具(前台执行,maxDepth: provider-managed——ACP 提供方无法
 *     在本地强制子代理深度)。
 *
 * 能力边界(ACP 语义):子代理是独立运行时,使用 CodeBuddy 自己的
 * 系统提示词、工具面与模型;dsh 侧只传递委派 prompt 文本与工作区
 * cwd(inheritsParentContext: false),并负责子进程环境(凭据 scrub +
 * 显式 env)、权限自动应答与生命周期销毁。
 * @module subagent-codebuddy
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "subagent-codebuddy";
export interface Config {
    /** 可执行文件,默认 `codebuddy`。 */
    command?: string;
    /** 传给 command 的参数,默认 `['--acp']`。 */
    args?: string[];
    /**
     * 子代理使用的 CodeBuddy 模型 ID,默认 `deepseek-v4-flash`,
     * 以 `--model <id>` 追加到 args。
     */
    model?: string;
    /** ctx.subagents 提供方名,默认 `codebuddy`。 */
    providerName?: string;
    /** 工具名,默认 `subagent_codebuddy`。 */
    toolName?: string;
    /**
     * 子代理权限请求自动应答:`reject`(默认,一律拒绝)或 `allow`
     * (批准首个 allow_once / allow_always 选项)。不弹给人。
     */
    permission?: 'allow' | 'reject';
    /** 子进程工作目录覆盖;缺省继承委派父会话 cwd。 */
    cwd?: string;
    /** 追加到子进程环境(叠加在凭据 scrub 后的父环境之上)。 */
    env?: Record<string, string>;
}
export declare const Config: z<Config>;
export declare function apply(ctx: Context, config: Config): void;
