/**
 * CodeBuddy ACP 连接层:JSON-RPC over stdio(ndjson)。
 *
 * 每个子代理委托一个 ACP 进程(`codebuddy --acp`),会话经 `session/new` /
 * `session/load` 复用;prompt 期间的生命周期(流式 update、协议级取消)由
 * CodeBuddy 官方 ACP 实现负责,替代此前自研的进程树管理与计时器猜测——
 * `session/cancel` 对生成流与正在执行的工具都是即时抢占(实测)。
 *
 * 活动语义(假死防御的关键,吸取 stderr 续命教训):
 * - **进展性事件**(agent_message_chunk / agent_thought_chunk / tool_call /
 *   tool_call_update)才重置动态空闲计时——它们代表任务真实推进;
 * - session_info_update / usage_update / config_option_update 等是 CLI 心跳,
 *   **不参与续命**,否则长思考/长工具期间的密集心跳会让死挂永不超时;
 * - stderr 只收集不续命,仅作错误归因证据。
 * @module subagent-codebuddy/acp
 */
import type { ChildProcess } from 'node:child_process';
import type { TokenUsage } from '@deepseek-ai/dsh-llm';
/** 默认动态空闲超时预算:与 agy 执行器同一套算法(无总时长上限)。 */
export declare const DEFAULT_ACP_RUN_TIMEOUTS: {
    firstMs: number;
    idleMinMs: number;
    idleMaxMs: number;
    idleFactor: number;
    idleWarmupLines: number;
    tailQuietMs: number;
    tailBgQuietMs: number;
    tailCapMs: number;
};
/** 动态空闲超时预算(测试注入小值压缩时间)。 */
export interface AcpTimeouts {
    firstMs?: number;
    idleMinMs?: number;
    idleMaxMs?: number;
    idleFactor?: number;
    idleWarmupLines?: number;
    /**
     * 在途工具期间的空闲硬顶(毫秒,默认 30 分钟;<=0 关闭)。
     * 正常长工具无心跳,空闲计时在工具在途时整体暂停;但工具**永不返回**
     * (CLI 卡死)+ 消费方被回收时,没有这层硬顶就会永久泄漏进程、
     * 子会话回合悬空(实测:侧边栏判定"目录损坏")。
     * 只咬「完全静默」的工具段——有任何中间 update 都会重置计时;超顶走
     * stall 重试(自动续跑),被误杀的工具通常工作已落盘,重跑代价可控。
     */
    guardCapMs?: number;
    /**
     * 尾巴窗口静默阈值(毫秒,默认 5s;<=0 关闭尾巴窗口)。
     *
     * CLI 的 `end_turn` **不等于**空闲:后台任务(后台 bash / agent 任务)完成时
     * CLI 会自发续跑,续跑内容以普通 update 推过来。dsh 回合若已收尾,插件就不在
     * 抽流,这些内容全丢(实测量产场景:模型说"跑完我重启后端,给你最终结果",
     * 回合一结束 CLI 进程就被杀,承诺的收尾永远不来)。
     * 尾巴窗口:干净收尾后继续抽流,直到
     *   - `session_info_update._meta["codebuddy.ai/agentPhase"]` 报 `idle` 且静默
     *     达到本阈值(普通回合代价 = 这段静默);
     *   - 或收到 `session_end`(CLI 广播:会话真正空闲,含后台任务/团队收尾);
     *   - 或撞上 {@link AcpTimeouts.tailCapMs} 硬顶。
     */
    tailQuietMs?: number;
    /**
     * 起了后台任务的回合的静默阈值(毫秒,默认 10 分钟)。
     *
     * 后台任务在跑时 CLI 可以长时间零 update(后台 `sleep 300` 之类),用普通
     * 阈值会在任务完成前就收尾。识别方式:落地的 `tool/call` 参数带
     * `run_in_background` / `background`(CLI Bash 的后台模式)。
     * 一旦看到**续跑内容**(settle 之后超过普通阈值才出现的内容 update),
     * 说明任务已回、CLI 在继续干活,阈值立即回到 {@link AcpTimeouts.tailQuietMs}。
     */
    tailBgQuietMs?: number;
    /** 尾巴窗口硬顶(毫秒,默认 30 分钟):后台任务最长可拖着回合不闭合的时长。 */
    tailCapMs?: number;
    /**
     * 模型调用边界的静默兜底(毫秒,默认 1000;回合泵用)。
     * 有工具调用来到、但既没有 `tool_executing` 心跳也没有工具结果时,内容静默
     * 超过本值即认定这次模型调用已结束(老 CLI 无 agentPhase 能力时的主要判据)。
     */
    boundaryQuietMs?: number;
    /** 收段前的用量宽限期(毫秒,默认 700;回合泵用):等本次调用的 usage 归段。 */
    usageGraceMs?: number;
}
/** ACP session/update 里我们消费的 update 类型(其余类型仅作活动判定时忽略)。 */
export interface AcpUpdate {
    sessionUpdate: string;
    content?: {
        type: string;
        text?: string;
    };
    messageId?: string;
    toolCallId?: string;
    title?: string;
    kind?: string;
    status?: string;
    rawInput?: Record<string, unknown>;
    rawOutput?: {
        type: string;
        text?: string;
    };
    /** CodeBuddy 私有扩展:工具名、参数完成标记等。 */
    _meta?: Record<string, unknown>;
}
/** 一次 session/prompt 的收尾。 */
export interface AcpPromptResult {
    stopReason?: string;
    errorMessage?: string;
    /**
     * CodeBuddy 私有扩展。失败详情在 `codebuddy.ai/errorMessage`(JSON 串,
     * 含 category/statusCode/业务码)与 `codebuddy.ai/traceId` 里;
     * 顶层 errorMessage 为空时这里才是唯一原因来源(实测 refusal 场景)。
     */
    _meta?: Record<string, unknown>;
}
/**
 * JSON-RPC 级失败:保留错误码与 data(限流/认证/模型服务等分类在 data 里,
 * 压成纯文本就丢失了可分类性)。
 */
export declare class AcpRpcError extends Error {
    readonly code: number | undefined;
    readonly data: Record<string, unknown> | undefined;
    constructor(code: number | undefined, message: string, data: Record<string, unknown> | undefined);
}
/** 进程退出信息。 */
export interface AcpExitInfo {
    code: number | null;
    signal: string | null;
}
/** 从 update 提取 CodeBuddy 私有工具名,并归一化为 dsh 工具名
 * (Read→read、TodoWrite→todo_write、WebSearch→web_search),
 * 让子代理窗口复用 dsh 原生工具的可视化渲染器。 */
export declare function toolNameOf(update: AcpUpdate): string;
/**
 * 从 `usage_update` 提取本次请求的用量(`_meta.usage`,OpenAI 风格字段)。
 *
 * 实测载荷:`prompt_tokens` / `completion_tokens` / `total_tokens` /
 * `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`,缓存命中还会镜像在
 * `prompt_tokens_details.cached_tokens`。映射到 dsh TokenUsage 的三个**不重叠**
 * 桶:未命中输入、缓存读、缓存写——命中桶优先取 OpenAI 风格的 hit 字段
 * (`cache_read_input_tokens` 在该载荷里恒为 0,不能优先)。
 * @param update - 一条 session/update。
 * @returns dsh 用量;载荷缺失或全零时为 undefined(心跳空载不计)。
 */
export declare function usageOfUpdate(update: AcpUpdate): TokenUsage | undefined;
/** 进展性事件:代表任务真实推进,重置动态空闲计时。 */
export declare function isProgressUpdate(update: AcpUpdate): boolean;
/** 一个 ACP 进程连接:JSON-RPC 请求/通知 + update 事件回调。 */
export declare class AcpConnection {
    private readonly onUpdate;
    readonly proc: ChildProcess;
    private nextId;
    private readonly pending;
    private exitInfo;
    private readonly exitWaiters;
    /** stderr 尾部(错误归因证据;只收集,不参与任何续命判定)。 */
    private stderrTail;
    /** close 原因:正常退出 / 被主动 kill(避免把自杀报成崩溃)。 */
    private killed;
    constructor(argvPrefix: readonly string[], cwd: string, onUpdate: (update: AcpUpdate) => void);
    /** 进程退出(含退出码);已在退出后调用则立即返回。 */
    onExit(listener: (info: AcpExitInfo) => void): void;
    /**
     * 发起一次 JSON-RPC 请求。
     * @param timeoutMs 超时毫秒;**<= 0 表示不设请求超时**——`session/prompt`
     * 这类长活请求(整个任务期间)必须传 0,它的生命周期由动态空闲超时
     * (cancel → kill → 进程退出 reject)与 abort 保护,固定超时会误杀长任务
     * (实测:默认 180s 把 3 分钟以上的子代理任务全部掐死)。
     */
    request<T>(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<T>;
    notify(method: string, params: Record<string, unknown>): void;
    /** stderr 尾部(有内容才带分号前缀)。 */
    stderrNote(): string;
    /** 主动终止:标记自杀,避免 close 被误判为崩溃。 */
    kill(): void;
    get wasKilled(): boolean;
}
