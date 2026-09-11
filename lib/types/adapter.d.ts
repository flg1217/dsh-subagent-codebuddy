/**
 * CodeBuddy 模型适配器:provider 路由 `codebuddy`,走 ACP(Agent Client Protocol)。
 *
 * 此前是 spawn `codebuddy -p` + 单向解析 stream-json:CLI 内部工具卡死时
 * 进程树杀不干净(工具子进程持有 stdout 写端),for-await 永久挂起,子代理
 * 假死且无任何错误反馈(实测,多机复现)。迁移到 ACP 后:
 *
 * - **会话生命周期官方化**:`session/new` / `session/load`(历史回放)复用
 *   长线会话;`session/prompt` 流式 `session/update`(含 thinking 流——
 *   单向 -p 模式没有的 agent_thought_chunk);
 * - **协议级取消**:`session/cancel` 对生成流与正在执行的工具都是即时抢占
 *   (实测),`stopReason: "cancelled"` 与正常结束明确区分;abort 信号驱动
 *   周期性重发(思考早期单次通知可能被吞);
 * - **静默失败自动重试**:CodeBuddy 服务端偶发静默失败(实测高频)——
 *   end_turn 但零思考零文本零工具、或只有思考没有产出。空跑会让主代理
 *   以为子代理完成了(用户看到"莫名中断、发继续没反应")。可重试失败
 *   自动恢复同一会话续跑(ACP session/load 回放),用尽才显式报错;
 * - **假死防御分层**:进展性 update(消息/思考/工具)重置动态空闲阈值;
 *   CLI 心跳(session_info/usage/config)与 stderr 不参与续命;静默超
 *   阈值先发 cancel、5s 仍无响应才 kill——进程退出码与 stderr 全程留证。
 * @module subagent-codebuddy/adapter
 */
import type { Context } from '@deepseek-ai/cordis';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { ConversationStore } from './conversations.js';
import type { AcpTimeouts } from './acp.js';
/**
 * 会话中最后一个已打开(尚无配对 step/end)的 turn/step。
 *
 * adapter 只在检测到调用方(agent-loop)已打开的 step 时直写事件——
 * 自己绝不创建 step,否则会与循环的 step 记账交错,破坏严格 v2 关系校验。
 * @param events - 会话自身的已提交事件(ownEvents)。
 * @returns 打开的 turn/step,没有则为 undefined。
 */
export declare function findOpenStep(events: readonly SessionEvent[]): {
    turn: number;
    step: number;
} | undefined;
/** CodeBuddy 读图输出解析结果:文本片段 + 待存附件服务的图片。 */
export interface ParsedImageOutput {
    /** 输出中的文本块(拼接),可能为空。 */
    text: string;
    /** data URI 解码后的图片字节与媒体类型。 */
    images: Array<{
        data: Uint8Array;
        mediaType: string;
    }>;
}
/**
 * 识别 CodeBuddy Read 工具读图的原始输出。
 * 形态:`[{"type":"image_url","image_url":{"url":"data:image/png;base64,..."}}, ...]`
 * (部分版本为 JSON 字符串,数组内可混有 text 块)。非该形态返回 undefined,
 * 调用方保持原有纯文本路径。
 * @param outputText - tool/result 的原始输出文本。
 * @returns 解析出的文本与图片;不是图片输出时为 undefined。
 */
export declare function parseCodebuddyImageOutput(outputText: string): ParsedImageOutput | undefined;
/** CodeBuddy CLI 入口配置(由 index.ts 解析)。 */
export interface CodebuddyAdapterOptions {
    /** 可执行入口(node 脚本绝对路径或命令)。 */
    command: string;
    /** 前置参数(如解析出的 CLI 路径)。 */
    prefixArgs: string[];
    /** 读取当前默认模型(调用时求值,设置面板改默认模型后对新请求实时生效)。 */
    modelOf: () => string;
    /** 传给 `--permission-mode` 的权限模式。 */
    permissionMode: string;
    /** 追加的额外 CodeBuddy 参数。 */
    extraArgs: string[];
    /** 动态空闲超时预算(可选,默认见 {@link DEFAULT_ACP_RUN_TIMEOUTS})。 */
    timeouts?: AcpTimeouts;
    /** 静默失败自动重试次数(默认 2:首次 + 1 次续跑)。 */
    maxAttempts?: number;
    /** 重试间隔(毫秒,默认 3s)。 */
    retryDelayMs?: number;
    /** 中途插入轮询间隔(毫秒,默认 1200;测试用小值)。 */
    steerPollMs?: number;
    /** 续接映射存储(默认持久化到 `~/.dsh/codebuddy/conversations.json`;测试传纯内存)。 */
    store?: ConversationStore;
    /** 原生会话文件根目录(默认 `~/.codebuddy/projects`;测试注入临时目录)。 */
    nativeBaseDir?: string;
}
/**
 * CodeBuddy 模型适配器。stream() 每次调用:
 * spawn `codebuddy --acp` → initialize → session/new(或 session/load 复用)
 * → session/prompt → 消费 session/update(思考/文本/工具)→ finish 收尾。
 * 每次调用一个 ACP 进程,用完退出;会话连续性由 CodeBuddy 会话存储 +
 * session/load 保证(实测回放完整);续接映射持久化,服务重启后自动恢复;
 * 静默失败自动恢复会话续跑。
 */
export declare class CodebuddyLlmAdapter extends LlmAdapter {
    private readonly ctx;
    private readonly options;
    /**
     * dsh 会话 → CodeBuddy ACP 会话的续接映射(持久化,跨服务重启恢复)。
     *
     * 首次调用 `session/new` 建立并记录;之后同一会话的每次 stream 都
     * `session/load` 载入同一会话(官方实现会先回放历史事件,回放不落地)。
     */
    private readonly conversations;
    /** listModels 缓存与并发合并(目录拉取热路径)。 */
    private modelCache;
    private modelFetch;
    /** 中继回退:同一会话最多保留的转发 id 数(防无界增长)。 */
    private static readonly FORWARDED_CAP;
    /** dsh 会话 → todo 列表状态(CodeBuddy 任务工具折算整表快照,跨轮复用)。 */
    private readonly todoStates;
    /** dsh 会话 → 已转发的插入消息 id(续聊补发时跳过,防重复)。 */
    private readonly forwardedInsertions;
    /** 标记一条插入为已转发;已标记过返回 false。 */
    private markForwarded;
    constructor(ctx: Context, options: CodebuddyAdapterOptions);
    /**
     * 绑定模型元数据与分发流入口(rc.2+ 的 LlmAdapter 接口)。
     * 显式实现而非依赖基类:插件对宿主 dsh-llm 版本保持兼容
     * (rc.6 宿主不调用此方法;rc.2+ 宿主调用本实现)。
     */
    prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{
        model: LlmResolvedModelInfo;
        stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>;
    }>;
    /** 取(或建)某会话的 todo 状态;首建时从已提交事件折叠最新 todo/write 播种。 */
    private todoStateFor;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    /**
     * 带重试的委托执行。可重试失败(静默空跑/半途终止/进程退出/超时)时
     * 恢复同一会话续跑;用尽后以显式错误收尾,让主代理知道子代理实际状态。
     */
    private streamWithRetry;
    /** 单次委托尝试:进程 + 握手 + prompt + update 消费。 */
    private streamOnce;
    resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    /** 主模型选择器里的 provider 分组名。 */
    providerInfo(provider: string): {
        id: string;
        name: string;
    };
    /**
     * 主模型选择器的模型目录:`codebuddy --help` 解析出的 id ∪ 设置里的默认模型。
     *
     * 目录路径会在客户端每次拉取时被调用,且 CLI 可能缺失/挂起——因此
     * 异步 spawn + 超时、成功缓存 10 分钟、失败缓存 60 秒、并发合并,
     * 并且**永不抛错**:CLI 不可用时回退到配置模型,保证 provider 仍可选择。
     */
    listModels(provider: string): Promise<readonly LlmModelInfo[]>;
}
