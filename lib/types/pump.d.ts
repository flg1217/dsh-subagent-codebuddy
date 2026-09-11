/**
 * 回合泵(路线 C1):**一个 CodeBuddy 回合 = 一个 ACP 进程 = 多个 dsh step**。
 *
 * 背景:CodeBuddy 的回合内部是「模型调用 → 工具执行 → 模型调用 …」的循环,
 * 而 dsh 的 step 语义是「一次模型调用 = 一个 step」。旧实现把整个 CodeBuddy
 * 回合塞进一次 provider 调用(=一个巨型 step),文本/工具顺序、每步统计、
 * 分页、客户端 last-wins 渲染全部错位。
 *
 * 本模块把那个内部循环显式化:
 * - **泵**:进程/握手/prompt 只做一次,持续消费 ACP update,按模型调用切段
 *   (segment);
 * - **attach()**:每个 dsh step 调一次,消费当前段;段在「工具调用边界」收尾
 *   时返回,agent-loop 于是写原生 `assistant/message` + `tool/call`,并调用
 *   本模块注册的**回放工具**执行工具调用——回放工具只等 ACP 报来的结果,
 *   由 loop 写原生 `tool/result`;随后 loop 开下一个 step,attach() 消费下一段;
 * - **收尾**:最后一段(无工具调用)在 tail 窗口结束后返回,loop 以
 *   `completed` 闭合回合。
 *
 * 边界识别(实测 cb-segment-probe.mjs):
 * - 工具调用以 `tool_call`(in_progress,参数流式)→ `tool_call`(pending,
 *   `toolArgumentsComplete=true`,全参)出现;`tool_call_update`(completed/failed)
 *   带结果;
 * - 模型调用结束的信号:`agentPhase` → `tool_executing`,或首个工具结果到达,
 *   或静默兜底(老 CLI 无 phase);
 * - `usage_update` 每次模型调用一条,在工具开始执行后 ~100ms 到;收段前给它
 *   一个短宽限期,保证每段带上自己的用量。
 * @module subagent-codebuddy/pump
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ContentBlock, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { AcpTimeouts } from './acp.js';
import type { TodoListState } from './todo-bridge.js';
import type { AttachmentsSaveFace } from './tool-image.js';
/** 会话面(todo 折叠/插话轮询需要 ownEvents;todo 快照写入需要 append)。 */
export interface PumpSessionFace {
    ownEvents?: () => readonly {
        type: string;
        data?: unknown;
    }[];
    append?: (type: string, data: unknown) => unknown;
}
/** 泵的宿主依赖(由 adapter 提供;避免与 adapter.ts 形成运行时循环)。 */
export interface PumpHost {
    ctx: Context;
    command: string;
    prefixArgs: string[];
    extraArgs: string[];
    /** 推理强度(--effort;未选则不传,保持 CLI 默认)。 */
    reasoningEffort?: string;
    timeouts?: AcpTimeouts;
    maxAttempts?: number;
    retryDelayMs?: number;
    steerPollMs?: number;
    nativeBaseDir?: string;
    /** dsh 会话 id(泵的键,也是回放工具注册的 scope)。 */
    dshSessionId: string;
    model: string;
    cwd: string;
    acpCwd: string;
    /** 已有 CodeBuddy 会话(load 复用);否则 session/new。 */
    resume?: {
        acpId: string;
    };
    prompt: string;
    images: Array<{
        data: string;
        mimeType: string;
    }>;
    /** load 失败时回退:完整历史重发的提示词。 */
    fallbackPrompt: () => Promise<{
        prompt: string;
        images: Array<{
            data: string;
            mimeType: string;
        }>;
    }>;
    /** 会话登记(续接锚点:sentCount = 本次发送时 dsh 消息总数)。 */
    rememberConversation: (acpId: string, sentCount: number) => void;
    /** 登记失效(CodeBuddy 侧会话丢失)。 */
    forgetConversation: () => void;
    sentCount: number;
    session?: PumpSessionFace;
    /** 子会话 header(镜像用)。 */
    childSession?: {
        header?: {
            agentPreset?: string;
            delegationDepth?: number;
        };
    };
    attachmentsOf: () => AttachmentsSaveFace | undefined;
    /** 本会话的 todo 折叠状态(跨回合复用;无则 undefined)。 */
    todoStateOf: () => TodoListState | undefined;
    /** 转发 id 标记(next-step 插话);已标记过返回 false。 */
    markForwarded: (id: string) => boolean;
}
/** 仅供测试:清空模块级注册表并释放残留的泵(跨用例隔离)。 */
export declare function resetPumpStateForTests(): void;
/** 重启跨 attempt 保留的执行状态(重试是同一任务的延续,已学到的间隔不丢)。 */
export interface PumpStepState {
    mirroredCalls: Set<string>;
    maxGapMs: number;
}
/**
 * 一个 CodeBuddy 回合的 ACP 泵。生命周期 = 从首次 provider 调用到回合收尾
 * (含 tail 窗口);期间 provider 可被调用多次(每个 dsh step 一次)。
 */
export declare class TurnPump {
    private readonly signal;
    private conn;
    private acpSessionId;
    private capturing;
    private readonly deps;
    private readonly to;
    private readonly maxAttempts;
    private readonly retryDelayMs;
    private readonly steerPollMs;
    private readonly boundaryQuietMs;
    private readonly usageGraceMs;
    private readonly stepState;
    private attempts;
    /** 段队列:进行中/已完成的模型调用段(attach 顺序消费)。 */
    private segments;
    private readonly calls;
    /** 本回合是否起过后台任务(工具参数 run_in_background/background)。 */
    private backgroundLaunched;
    /** 是否产出过文本(静默失败判定:块可能尚未闭合)。 */
    private hasText;
    private finished;
    private failed;
    private disposed;
    /** 看门狗状态(与旧直写实现同一套动态预算)。 */
    private lastProgressAt;
    private progressSamples;
    private maxGapMs;
    private lastBudgetMs;
    private stallTimedOut;
    private killTimer;
    private cancelLoopTimer;
    /** 尾巴窗口状态。 */
    private promptSettled;
    private stopReason;
    private inFlight;
    private promptError;
    private agentPhaseSeen;
    private sessionEnded;
    private lastUpdateAt;
    private lastContentAt;
    private tailStartAt;
    private tailDeadline;
    /** 收段判定辅助。 */
    private boundarySeenAt;
    /** 边界/收尾的一次性补判定定时器(心跳粒度不够时的精确收口)。 */
    private checkTimer;
    private usageGraceUntil;
    private toolExecutingSeen;
    private firstResultSeen;
    /** steer 轮询。 */
    private lastSteerPoll;
    /** 子代理镜像 / todo 桥。 */
    private readonly mirrors;
    private readonly subagentCallIds;
    private readonly tickTimer;
    private wake;
    /** 外部 abort(agent-loop 的回合信号)。 */
    private readonly onAbort;
    constructor(deps: PumpHost, signal: AbortSignal | undefined, stepState: PumpStepState);
    /** 回放工具 → 当前泵(未在跑/已收尾时为 undefined)。 */
    static forSession(sessionId: string): TurnPump | undefined;
    /** 回合是否已被调用方中止(abort 交给 loop 的中断语义收尾)。 */
    private get aborted();
    /**
     * 附加到本回合的下一段:顺序吐出该段的 chunk;段在工具边界或回合收尾处返回。
     * 每个 dsh step 调一次。abort 直接返回(由 loop 的中断语义收尾)。
     */
    attach(): AsyncGenerator<StreamChunk>;
    private isMaxTokens;
    /** 起一次 ACP 进程 + 握手 + prompt(重启路径也走它)。 */
    private runAttempt;
    private sendPrompt;
    /** 回合收尾:断开进程、清空活跃表、唤醒所有等待者。 */
    private finishTurn;
    /** 失败:首段无产出 → 重启;否则整体失败(消费方抛出,loop 收错误回合)。 */
    private failRun;
    /** 重启资格:仍是首段、本回合无任何产出、还有重试次数。 */
    private canRestart;
    private restart;
    /** 补一次「到期即判定」的定时器(收段宽限/尾巴静默预算)。 */
    private armCheck;
    /** 释放进程与计时器(幂等;不改变 finished 状态)。 */
    private disposeProcess;
    /** 整体收尾:释放一切,唤醒等待者。 */
    dispose(): void;
    /**
     * 等一次工具调用的结果(回放工具的 execute 调用面)。
     * 结果文本截断 2000 字符(与旧直写路径一致);图片结果转 attachment 内容块,
     * 避免 base64 进会话。
     */
    awaitResult(callId: string, signal?: AbortSignal): Promise<{
        blocks: ContentBlock[];
        meta?: unknown;
    }>;
    /** 为此 agent 注册一个回放工具(同名工具名只注册一次)。 */
    private ensureReplayTool;
    private onUpdate;
    /** 单条 update 的状态机(不触发收段判定)。 */
    private applyUpdate;
    /** 参数完整的工具调用:注册回放工具 → 段内发射 tool-call 块。 */
    private announceCall;
    /** 取(或建)当前打开的段。 */
    private openSegment;
    private closeOpenBlock;
    private closeSegment;
    /** 心跳:steer 轮询 → 看门狗 → 收段判定 → tail 收尾。 */
    private tick;
    /** 收段判定:工具边界。 */
    private checkSegmentBoundary;
    /** tail 窗口:prompt 干净收尾后继续抽流(后台任务会自发续跑)。 */
    private checkTail;
    /** 动态空闲看门狗:进展性事件续命;在途工具/等结果期间只保留硬顶。 */
    private checkStall;
    private stall;
    private armProgress;
    /**
     * 未 claim 的 next-step 插话 → ACP `session/steer`(下一个内部边界注入)。
     *
     * C1 下 loop 会在**下一个模型调用边界**claim 这条消息并原生写 `user/message`
     * ——插话的队列停留不再是一整轮(旧实现的巨型 step 才需要手工摘队列)。
     */
    private pollInsertions;
    private replayTodos;
    private emitTodo;
    private landTodo;
    private confirmTodo;
    private maybeStartMirror;
    private finishMirror;
    private waitEvent;
    private wakeAll;
}
