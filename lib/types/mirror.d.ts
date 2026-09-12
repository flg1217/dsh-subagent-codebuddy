/**
 * CodeBuddy 子代理 → dsh 影子子会话镜像。
 *
 * codebuddy 驱动的轮次里,Agent 工具会派生 CodeBuddy 自己的子代理,其转录
 * 落在 `~/.codebuddy/projects/<slug>/<sessionId>/subagents/<agentId>.jsonl`
 * (与主会话同记录格式)。本模块把它实时镜像成 dsh 的**子会话**:
 *
 * - `sessions.create` 建带 lineage 的会话(header.parentSession + origin:
 *   'subagent'),侧边栏的子代理目录据此发现它;
 * - 写入 `subagent/descriptor`(投影据此分类 label/mode);
 * - 转录逐条转成 dsh 事件直写该会话(本会话没有 agent-loop,adapter 是
 *   唯一写入者,自行维护 turn/step 结构与工具广告/结果配对);
 * - 轮询文件做近实时跟随,Agent 调用结束时收尾(未决工具补错误结果,
 *   闭合 step/turn)。
 *
 * 事件序列与主会话同规:tool/call 前必有 assistant/message 广告(name/
 * arguments 逐字一致),step/end 时无未决工具——满足严格 v2 关系校验。
 * @module subagent-codebuddy/mirror
 */
/** 影子会话的最小操作面(sessions 服务)。 */
export interface ShadowSessionFace {
    create(id?: unknown, options?: {
        meta?: Record<string, unknown>;
    }): {
        readonly id: string;
        append: (type: string, data: unknown, opts?: unknown) => {
            readonly seq: number;
        } | undefined;
    };
}
/** 镜像依赖。 */
export interface MirrorDeps {
    /** sessions 服务(create 建影子会话)。 */
    sessions: ShadowSessionFace;
    /** 父(dsh)会话 id。 */
    parentSessionId: string;
    /** 子代理的工作目录(与 CodeBuddy 项目 slug 对齐)。 */
    cwd: string;
    /** 父会话在 CodeBuddy 侧的 ACP sessionId(子代理目录名)。 */
    acpSessionId: string;
    /** 子代理转录的目录根(默认 `~/.codebuddy/projects`;测试注入)。 */
    projectsRoot?: string;
    /** 图片入库面(attachments 服务;缺省时图片退化为 `[图片]` 文本)。 */
    attachments?: MirrorImages;
    /** 父会话的 agentPreset(影子会话头与其保持一致,便于分类/导航)。 */
    agentPreset?: string;
    /** 轮询间隔(毫秒,默认 1500)。 */
    pollMs?: number;
    /** 日志(默认静默)。 */
    log?: (message: string) => void;
}
/** 一条 CodeBuddy 转录记录(宽松)。 */
interface NativeRecord {
    type?: string;
    role?: string;
    name?: string;
    callId?: string;
    arguments?: unknown;
    status?: string;
    output?: {
        type?: string;
        text?: string;
    };
    content?: Array<{
        type?: string;
        text?: string;
        blob_path?: string;
        mime?: string;
    }>;
    rawContent?: string;
    summary?: string;
    providerData?: {
        requestModelId?: string;
        model?: string;
    };
}
/** 图片入库面:blob 字节 → dsh attachment 引用(saveImage 由 attachments 服务提供)。 */
export interface MirrorImages {
    saveImage: (data: Uint8Array, mediaType: string) => Promise<unknown>;
}
/** 从 Agent 工具结果文本解析子代理 id(`[Agent ID: agent-xxx]`)。 */
export declare function agentIdFromOutput(text: string): string | undefined;
/** 一批转录记录 → dsh 事件(纯函数,便于测试与官方校验器验证)。 */
export declare class RecordTranslator {
    private readonly append;
    private readonly model;
    private readonly images?;
    private stepOpen;
    private turnOpen;
    private readonly callSeqs;
    private readonly advertised;
    /** 子代理的任务/todo(整表快照,镜像侧同桥接)。 */
    private readonly todos;
    /** read_image 别名调用的 meta 路径(callId → path,结果落地时写 meta)。 */
    private readonly imageReadPaths;
    constructor(append: (type: string, data: unknown, opts?: unknown) => unknown, model: string, images?: MirrorImages | undefined);
    /** 开头:turn + step + 描述符。 */
    begin(descriptor: {
        provider: string;
        label: string;
    }): void;
    /** 收尾:未决工具补错误结果,闭合 step/turn。 */
    end(): void;
    /** 应用一条转录记录(图片需异步入库)。 */
    apply(record: NativeRecord): Promise<void>;
}
/**
 * 一个 Agent 调用的镜像:建影子会话 → 跟随转录文件 → 收尾。
 */
export declare class SubagentMirror {
    private readonly deps;
    private readonly pollMs;
    private readonly root;
    private readonly log;
    private shadow;
    private translator;
    private file;
    private offset;
    /**
     * sync 串行链:定时轮询与终读共用一条链。translator 是状态机(累积
     * assistant 消息/工具调用),并发 apply 会让事件乱序甚至破坏状态。
     */
    private chain;
    private startedAt;
    private prompt;
    private timer;
    private finished;
    /** 影子会话 id(创建后可用,供外部引用)。 */
    get shadowId(): string | undefined;
    constructor(deps: MirrorDeps);
    /** 子代理转录目录。 */
    private subagentsDir;
    /** 开始镜像:建影子会话并进入跟随。 */
    start(agent: {
        label: string;
        prompt: string;
        delegationDepth: number;
    }): void;
    /** 定位转录文件(新建、未被占用、提示词前缀匹配优先)。 */
    private locateFile;
    /** 拉取一次增量(也由测试直接调用)。内部全量容错:镜像失败绝不能拖垮主轮。 */
    syncOnce(): Promise<void>;
    /** 串行排入一次 sync(定时器/终读共用;上一轮结束后才开始下一轮)。 */
    private enqueueSync;
    /** 增量读取主体;异常由 {@link syncOnce} 兜底。 */
    private syncOnceUnsafe;
    /** 收尾:终读一次(排在已入队的 sync 之后),闭合结构与计时器(全量容错,同 {@link syncOnce})。 */
    finish(agentId?: string): Promise<void>;
}
export {};
