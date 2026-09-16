import type { Context } from '@deepseek-ai/cordis';
/**
 * 注册模型列表路由。trustedHosts 取自 webStartup(与 --trusted-host 一致);
 * 服务缺失(非 web profile)时不注册。
 * @param ctx - 插件上下文。
 * @param readCommand - 读当前生效的 CodeBuddy 命令(设置面板可改)。
 * @returns 释放函数。
 */
export declare function registerCodebuddyModelsRoute(ctx: Context, readCommand: () => string): () => void;
