/**
 * CodeBuddy 设置面板支持(服务端):
 * - 模型探测通道:客户端卡片按钮走 api.llm.discoverModels({
 *     settingsNs: 'codebuddy', provider: 'status' | 'test' }),
 *   服务端直接 spawn codebuddy CLI,不落会话、不动源码。
 * - provider 'status' → 检测安装/登录;provider 'test' → 真实连通性测试。
 * @module subagent-codebuddy/settings
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { Config } from './index.js';
/** 模型探测通道的 settingsNs 键(客户端卡片与之对应)。 */
export declare const CODEBUDDY_SETTINGS_NAMESPACE: never;
/** 设置表单 schema(与插件 Config 对齐;设置面板可编辑,重启后生效)。 */
export declare const CodebuddySettingsConfig: z<Schemastery.ObjectS<{
    command: z<string, string>;
    model: z<string, string>;
    permissionMode: z<string, string>;
}>, Schemastery.ObjectT<{
    command: z<string, string>;
    model: z<string, string>;
    permissionMode: z<string, string>;
}>>;
/** 当前生效的 CodeBuddy 配置(表单值优先,插件行配置兜底)。 */
export interface EffectiveCodebuddySettings {
    command: string;
    model: string;
    permissionMode: string;
}
/**
 * Windows 下把 `codebuddy` 命令解析为 node 可直接 spawn 的形式。
 * npm 全局安装只生成 `.cmd` shim + shebang 脚本,node 的 spawn 无法
 * 直接执行(ENOENT);解析 shim 拿到真实 JS 入口后用 `node <cli>` 启动。
 * 原生安装(.exe)或显式路径则原样使用。
 * @returns 可 spawn 的 command 与其前置参数。
 */
export declare function resolveSpawnableCommand(command: string): {
    command: string;
    args: string[];
};
/** 检测 CodeBuddy 是否已安装(命令存在且可执行)。 */
export declare function codebuddyInstalled(command: string, prefixArgs: string[]): boolean;
/**
 * 检测 CodeBuddy 登录状态(启发式)。
 * CLI 没有 auth 状态命令;可靠依据:数据目录 `~/.codebuddy/sessions` 存在
 * 会话记录(说明完成过登录与使用)。会话可能过期,以"测试"按钮结果为准。
 */
export declare function codebuddyLoggedIn(): boolean;
/** 发起真实测试:让 CodeBuddy 回答一个真实问题,返回实际回复内容。 */
export declare function codebuddyTest(command: string, prefixArgs: string[]): Promise<{
    ok: boolean;
    output: string;
}>;
/**
 * 注册设置区与模型探测通道(客户端卡片按钮走 api.llm.discoverModels,不落会话)。
 * 设置区是卡片在"设置 → 插件"页出现的前提:该页按 settings namespace
 * 派发卡片(key = namespace);表单值优先于插件行配置,改动后重启生效。
 * @returns 读取当前生效配置的函数。
 */
export declare function registerCodebuddySettings(ctx: Context, config: Config): Promise<() => EffectiveCodebuddySettings>;
