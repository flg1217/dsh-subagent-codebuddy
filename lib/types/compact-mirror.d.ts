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
 * ## 触发时机与安全
 * 跑在 `agent/pre-step`(回合进行中、step 之间)——与 dsh 自己的压缩同一个相位,
 * 所以事务的 `turn` 归属天然正确,也不会跨 `turn/end`。整组事件同步追加完,
 * 中途不 yield。
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
