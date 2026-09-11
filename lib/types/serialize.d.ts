/**
 * 序列化模块:把 dsh 消息翻译为 CodeBuddy 单轮 prompt。
 * - 系统提示(可选)、对话消息按顺序拼接为文本;
 * - 图片块读字节后以 **ACP 原生 image 内容块**(base64)随 prompt 发送
 *   (`promptCapabilities.image` 实测支持,不再落盘走路径——避开 CodeBuddy
 *   Read 工具的 256KB 上限);
 * - 续聊补发(`resumeReplayPrompt`):从发送锚点切片,把切换模型期间缺失的
 *   轮次完整补上,同时跳过 CodeBuddy 自己产生的消息(其会话里已有)。
 * @module subagent-codebuddy/serialize
 */
import type { Context } from '@deepseek-ai/cordis';
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm';
/** 续跑兜底:仅当没有可补发内容时使用。 */
export declare const CONTINUE_PROMPT = "\u7EE7\u7EED\u5B8C\u6210\u4E4B\u524D\u672A\u5B8C\u6210\u7684\u4EFB\u52A1,\u6301\u7EED\u63A8\u8FDB\u76F4\u5230\u4EFB\u52A1\u5B8C\u5168\u5B8C\u6210\u6216\u9047\u5230\u5FC5\u987B\u7528\u6237\u51B3\u7B56\u7684\u963B\u585E\u2014\u2014\u4E0D\u8981\u6BCF\u8F6E\u53EA\u505A\u4E00\u5C0F\u6B65\u5C31\u505C\u4E0B\u6C47\u62A5\u3002\u57FA\u4E8E\u5F53\u524D\u5DE5\u4F5C\u533A\u72B6\u6001\u7EE7\u7EED,\u4E0D\u8981\u91CD\u590D\u5DF2\u5B8C\u6210\u7684\u5DE5\u4F5C;\u5168\u90E8\u5B8C\u6210\u540E\u7ED9\u51FA\u6700\u7EC8\u7ED3\u679C\u62A5\u544A\u3002\u542F\u52A8 dev server \u7B49\u957F\u9A7B\u8FDB\u7A0B\u65F6\u5FC5\u987B\u7528 Bash \u7684 run_in_background: true \u53C2\u6570\u540E\u53F0\u8FD0\u884C\u2014\u2014\u524D\u53F0\u8FD0\u884C\u6C38\u4E0D\u8FD4\u56DE\u4F1A\u5361\u6B7B\u6574\u4E2A\u4EFB\u52A1\u3002";
/** 序列化结果:prompt 文本 + ACP 原生图片内容块(base64)。 */
export interface SerializedPrompt {
    prompt: string;
    images: Array<{
        data: string;
        mimeType: string;
    }>;
}
/**
 * 续聊兜底:只发**用户自己发的**最后一条消息(锚点缺失/历史被压缩收缩时)。
 *
 * 必须按 `source.kind === 'user'` 精确取:插件注入的上下文(系统提醒、
 * 工作区指令、技能目录)同样是 user 角色、且排在用户消息**之后**,
 * 按"最后一条 user 角色"取会把用户输入整条顶掉——实测:压缩完成后
 * 被 claim 的排队消息丢失,模型只看到技能目录提醒。
 */
export declare function lastUserPrompt(ctx: Context, messages: readonly Message[]): Promise<SerializedPrompt>;
/**
 * 续聊补发:把上次发送锚点(`sentCount`)之后的消息完整补发。
 *
 * 锚点之后先跳过 CodeBuddy 自己产生的消息(assistant 与 tool 结果——其会话里
 * 已有)与**已中途转发的插入消息**(`skipIds`——其文本已作为排队 prompt 送达,
 * 补发会重复),其余(切换其他模型期间产生的轮次、新的用户输入、压缩摘要等)
 * 全部按 User/Assistant 序列化发出。锚点缺失或历史被压缩收缩时退回最后一条用户消息。
 * @param ctx - 插件上下文(读取附件服务)。
 * @param messages - 当前 dsh 折叠视图的完整消息序列。
 * @param sentCount - 上次发送时的消息数锚点(未知则退回兜底)。
 * @param skipIds - 已在生成中转发过的插入消息 id 集合(可选)。
 * @returns 序列化结果(prompt + 原生图片块)。
 */
export declare function resumeReplayPrompt(ctx: Context, messages: readonly Message[], sentCount: number | undefined, skipIds?: ReadonlySet<string>): Promise<SerializedPrompt>;
/** 把一组消息序列化为 prompt(无系统提示);图片走原生内容块。 */
export declare function serializeMessages(ctx: Context, messages: readonly Message[]): Promise<SerializedPrompt>;
/** 把 harness 消息序列化为 CodeBuddy 单轮 prompt;图片走原生内容块。 */
export declare function buildPrompt(ctx: Context, options: GenerateOptions): Promise<SerializedPrompt>;
