/**
 * CodeBuddy 可用模型查询。
 *
 * CodeBuddy CLI 没有独立的 `models` 子命令,但 `--help` 的 `--model` 选项
 * 描述里自带 "Currently supported: (...)" 列表——spawn `--help` 解析该段。
 * 解析结果既是 opt-in 查询工具的数据源,也是 adapter `listModels()` 的目录
 * 来源(主代理模型选择器)。
 * @module subagent-codebuddy/models
 */
import type { Context } from '@deepseek-ai/cordis';
/** 从 `--help` 文本解析支持的模型 id 列表(空 = 解析失败)。 */
export declare function parseCodebuddyModelIds(helpText: string): string[];
/** 同步查询 CodeBuddy CLI 的 `--help`,返回支持的模型 id 列表。 */
export declare function listCodebuddyModelIds(command: string, prefixArgs: string[]): string[];
/**
 * 异步查询模型 id(不阻塞事件循环,供 adapter `listModels()` 的目录路径)。
 * 失败/超时/解析不到时返回空数组,由调用方决定回退策略。
 */
export declare function listCodebuddyModelIdsAsync(command: string, prefixArgs: string[], timeoutMs?: number): Promise<string[]>;
/** 解析 CodeBuddy CLI 的 `--help` 输出,返回当前支持的模型 id 列表文本。 */
export declare function listCodebuddyModels(command: string, prefixArgs: string[]): string;
/** 注册模型查询工具(与 subagent_codebuddy 配套;默认关闭的 opt-in 面)。返回注销函数。 */
export declare function registerCodebuddyModelsTool(ctx: Context, options: {
    command: string;
    prefixArgs: string[];
    toolName: string;
}): () => void;
