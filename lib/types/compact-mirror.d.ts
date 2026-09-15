/**
 * 镜像 CodeBuddy CLI 自己的压缩到 dsh(纯逻辑同步,**零 token**)。
 *
 * ## 为什么需要
 * dsh 只是渲染层:codebuddy 会话的真实上下文与压缩都由 CLI 负责,所以插件接管了
 * dsh 的自动压缩(`registerCompactDelegation`)。但 CLI 自己压完之后,dsh 界面上
 * 什么都不显示,用户看不出"这里压缩过"。本模块把 CLI 的那次压缩**镜像**成 dsh 的
 * 一次压缩事务,于是 UI 出现标准的压缩卡。
 *
 * ## 关键:不调模型
 * dsh 的压缩卡由「一条 `surfaceOp: replace` 的 checkpoint 消息」带出来
 * (`ui-chat/.../command.ts` 的 `compactSource()` 要求 `isReplacementSurfaceEvent`)。
 * 本模块**自己写这组事件**,摘要文本直接照抄 CLI 的原文——不调用任何 LLM,
 * 因此不消耗 token,只有本地文件读取 + 本地日志写入。
 *
 * ## 事件形状必须与 dsh 原生压缩逐字对齐
 * 会话层会校验,少任何一项 append 都会抛错(而错误会被本模块的 catch 吞掉 →
 * 功能静默失效),所以:
 * - checkpoint 用 `createUserMessage` 造(自动带 `role:'user'` 与稳定 `id`);
 * - replace 事件的 `sourceEventSeqs` 必须**覆盖每一个被遮蔽节点**,写法与
 *   `compaction-basic/src/region.ts` 一致:`[startSeq, summarySeq, ...shadowedSeqs]`。
 *
 * ## 检测
 * CLI 的会话文件 `~/.codebuddy/projects/<slug(cwd)>/<acpId>.jsonl` 里,它自己的每次
 * 压缩都会落一条 `{"type":"summary", "summary": "...", "providerData":{"source":"periodic"}}`
 * (实测;`source` 还有 `initial-user-message`,那是种子首条,不算压缩)。本模块按
 * 字节偏移量 tail 该文件,只认新增的 `periodic` 记录。
 *
 * ## 只镜像 CLI 自己触发的那次
 * 手动 `/compact` 是 dsh 转发给 CLI 的,命令自己的回执已经报过它;CLI 随之写出的
 * 摘要若也镜像,同一次压缩就出现两条消息。所以 dsh 发起过的压缩由
 * {@link isSelfInitiatedCompaction} 认领并跳过(判定按时间线,见该模块)。
 *
 * ## 触发时机与安全
 * 挂在两个回合内的相位上,都在 `turn/end` 之前,所以事务的 `turn` 归属天然正确、
 * 也不会跨回合;整组事件同步追加完,中途不 yield:
 * - `agent/pre-step`:CLI 在 step 之间压的;
 * - `agent/turn-stopping`:CLI 在回合收尾压的——**最常见的一种**(实测 CLI
 *   07:59:40 写摘要、回合 07:59:44 结束)。只挂 pre-step 的话这一轮再没有下一个
 *   step,卡片与上下文容量都要等到下一个大轮才出现。
 * @module subagent-codebuddy/compact-mirror
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ConversationStore } from './conversations.js';
/** 挂载依赖。 */
export interface CompactMirrorDeps {
    ctx: Context;
    conversations: ConversationStore;
    /** 本插件注册的 provider 名:只有路由到它的会话才镜像。 */
    providerName: string;
    /** CLI 会话文件基目录(测试可注入;默认 `~/.codebuddy/projects`)。 */
    nativeBaseDir?: string;
}
/**
 * 在每个 agent 的 `agent/pre-step` 上检查一次:CLI 是否新压了一次?压了就镜像。
 * 镜像失败只记日志,绝不影响回合。
 * @param deps - 挂载依赖。
 */
export declare function registerCompactMirror(deps: CompactMirrorDeps): void;
/**
 * 测试用:清掉按会话的读取游标。游标是模块级的(按 dsh 会话 id 记忆),同一
 * 测试文件里各用例的会话 id 相同,不清就会继承上一条用例的偏移量。
 */
export declare function resetCompactMirrorStateForTests(): void;
