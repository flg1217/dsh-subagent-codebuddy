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
/** 默认动态空闲超时预算:与 agy 执行器同一套算法(无总时长上限)。 */
export declare const DEFAULT_ACP_RUN_TIMEOUTS: {
    firstMs: number;
    idleMinMs: number;
    idleMaxMs: number;
    idleFactor: number;
    idleWarmupLines: number;
};
/** 动态空闲超时预算(测试注入小值压缩时间)。 */
export interface AcpTimeouts {
    firstMs?: number;
    idleMinMs?: number;
    idleMaxMs?: number;
    idleFactor?: number;
    idleWarmupLines?: number;
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
