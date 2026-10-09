/**
 * 模型在 CodeBuddy 与 dsh 原生之间切换时,注入**工具面说明**。
 *
 * dsh 核心只注入一条"模型变了"(core/agent 的 modelSwitchNotice:assistant
 * 历史由旧模型生成、会话继续用新模型)。但两条路由的工具面是**两套**:
 *
 * - CodeBuddy 回合内:CLI 原生工具(Bash/Read/Edit/Write/Glob/Grep 等)全禁,
 *   一律走 dsh 桥工具(mcp__dsh__* / dsh_* 委托);
 * - dsh 原生回合:工具恢复原生形态,而桥的**回放代理**(cli_ 前缀,记录 CLI
 *   曾调用过的原生工具)只在其回合内有效。
 *
 * 这条差异不注入,切换后的第一步模型就会按上一个模型的习惯选错工具
 * (实测:codebuddy → dsh 原生后误选残留 cli_* 读图工具,报"没有运行中的
 * CodeBuddy 回合"而损坏读图)。
 *
 * 时机:`model/selection` 事件记下切换,下一次 pre-step 注入(空步会丢消息,
 * 与 modelSwitchNotice 同一守卫——空步保留待注入,等真正发请求的那一步)。
 * @module subagent-codebuddy/tool-guide
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ContextFormed } from '@deepseek-ai/dsh-llm';
/**
 * 本插件注入消息的 source。
 *
 * 0.2.1 起 `MessageSourceMap` 是 merge-extensible 的:每个生产者在自己的
 * 模块里声明 kind,通用的 `'plugin'` 兜底已退役(会话格式 v4 明确拒绝
 * `kind: 'plugin'`)。UI 按 `form: 'notice' + summary` 渲染折叠行,与 kind 无关。
 */
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        'codebuddy': {
            kind: 'codebuddy';
        } & ContextFormed;
    }
}
/**
 * 安装"路由切换 → 工具面说明"注入。
 * @param ctx - 插件上下文(session/event 与 agent/pre-step 两个事件面)。
 */
export declare function installModelSwitchToolGuide(ctx: Context): void;
