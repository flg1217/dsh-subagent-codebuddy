/**
 * CodeBuddy 可用模型查询工具。
 *
 * CodeBuddy CLI 没有独立的 `models` 子命令,但 `--help` 的 `--model` 选项
 * 描述里自带 "Currently supported: (...)" 列表——spawn `--help` 解析该段,
 * 主代理先查询再以准确的 model id 委派。
 * @module subagent-codebuddy/models
 */
import type { Context } from '@deepseek-ai/cordis';
/** 解析 CodeBuddy CLI 的 `--help` 输出,返回支持的模型 id 列表(空 = 解析失败)。 */
export declare function listCodebuddyModelIds(command: string, prefixArgs: string[]): string[];
/** 解析 CodeBuddy CLI 的 `--help` 输出,返回当前支持的模型 id 列表文本。 */
export declare function listCodebuddyModels(command: string, prefixArgs: string[]): string;
/** 注册模型查询工具(与 subagent_codebuddy 配套)。 */
export declare function registerCodebuddyModelsTool(ctx: Context, options: {
    command: string;
    prefixArgs: string[];
    toolName: string;
}): void;
