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
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import type { ContentBlock, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { AcpTimeouts } from './acp.js';
import type { TodoListState } from './todo-bridge.js';
import type { AttachmentsSaveFace } from './tool-image.js';
import type { DshToolRunResult } from '@flg1217/dsh-mcp';
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
    /**
     * 工具桥接模式(默认 `mcp`):mcp = spawn 加 `--mcp-config` 连 dsh 的 HTTP
     * MCP server、不发 delegate 注册;delegate = 旧 DelegateTool 通道。
     */
    bridgeMode?: 'mcp' | 'delegate';
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
    /** 会话登记(续接锚点:sentCount = 本次发送时 dsh 消息总数;lastMessageId = 本次覆盖到的最后一条消息)。 */
    rememberConversation: (acpId: string, sentCount: number, lastMessageId?: string, systemHash?: string) => void;
    /**
     * 本次回合 dsh system prompt 的版本哈希(随续接记录落盘):记录"CLI 已见过
     * 哪一版 system prompt",内容变化时适配器才补发(见 adapter.systemHashOf)。
     */
    systemHash?: string;
    /** 本次发送覆盖到的最后一条消息 id(补发主锚,写回续接记录)。 */
    sentLastMessageId?: string;
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
    /** 查询 id 是否已投递过(悬挂条目每轮重折叠,靠它跳过已发的)。 */
    isForwarded?: (id: string) => boolean;
    /** 撤销投递标记(prompt 回退发送失败时回滚,留给补发路径)。 */
    unmarkForwarded?: (id: string) => void;
}
/** 仅供测试:释放残留的泵(跨用例隔离)。 */
export declare function resetPumpStateForTests(): void;
/**
 * 回放工具的 presentationMeta 投影:只透传显式 meta(无损 JSON 对象),
 * 缺失/非法一律给 `{}`。
 *
 * dsh 的工具框架对投影结果做无损 JSON 快照——返回 `undefined` 会被判
 * `INVALID_TOOL_OUTPUT` 并把**真实工具结果整个吞掉**(实测:委托工具的子代理
 * 输出因此变成 "returned invalid output",模型只看到报错)。
 * @param value - 回放工具返回值(`{ blocks, meta? }`)。
 * @returns 可快照的投影元数据(至少是空对象)。
 */
export declare function replayPresentationMeta(value: unknown): Record<string, JsonValue>;
/**
 * 尾注里向模型声明的"前台工具调用超时预算"(秒)。
 *
 * ⚠️ **这是未经验证的引导值,不是测得的客户端超时。** 代码里不存在任何 30s
 * 常量(ACP 默认是 firstMs 60s / idleMinMs 150s / idleMaxMs 600s);30s 只是
 * 为了让模型"长命令一律走 run_in_background"而写进尾注的保守口径。
 * **只用于尾注文案,不得再拿它推导服务端看门狗**(2026-09-13 曾这样推导过一次,
 * 见 {@link MCP_CALL_TIMEOUT_MS} 的说明)。
 */
export declare const CLI_TOOL_CALL_TIMEOUT_S = 30;
/**
 * MCP 通道转发看门狗(毫秒):**"注入未被消费"的异常兜底,不是工具执行时长上限**。
 *
 * 正常路径下它不该触发,因为两条腿各有归宿:
 * - 注入的段一旦被 loop 消费,工具就在 dsh 原生管线里跑——跑多久由工具自己与
 *   loop 的静默看门狗(guardCapMs,默认 30 分钟)决定。**长命令本来就该慢慢跑完**,
 *   不该被这一层截断(前台阻塞式长任务同样如此)。
 * - 回合结束 / 泵释放时,`finish()` / `dispose()` 会立刻 reject 所有等待者,
 *   不依赖本看门狗。
 * 所以它唯一覆盖的是"loop 卡死但回合尚未结束"这种异常,取值应当**宽松**。
 *
 * **2026-09-13 修正记录(重要)**:本值一度被改成 25s,依据是"CLI 侧 30 秒超时"。
 * 该 30 秒经查只是尾注里的一句断言({@link CLI_TOOL_CALL_TIMEOUT_S}),代码中并无
 * 对应常量,属**未经验证的数字**。用未验证的数字反推看门狗会带来实际回归:任何
 * 前台耗时 >25s 的命令(构建/测试/迁移)都会被误判超时并回 `McpDispatchTimeoutError`,
 * 而它本来可以正常跑完并把结果交回模型。故恢复宽松兜底。
 *
 * 若将来**实测**出 CLI 客户端的真实超时 T_client(手段:mcp-server.ts 的
 * `clientGoneAt` 日志已带"客户端等待"耗时),再考虑把本值调到略小于 T_client——
 * 那样能在客户端放弃前,把"勿盲目重试"这句更明确的错误先送到模型手里。届时应同时
 * 把 {@link CLI_TOOL_CALL_TIMEOUT_S} 的尾注口径对齐到实测值。
 */
export declare const MCP_CALL_TIMEOUT_MS = 300000;
/**
 * 交互式工具(等真人作答)的转发兜底窗口。
 *
 * 300s 对 `ask_user_question` / `exit_plan_mode` 这类工具天然不够:loop 完全健康
 * (工具正在执行、就等用户点提交),超时杀掉的不是"卡死的注入"而是"还没作答的人"。
 * 实测(2026-09-16):用户在 300s 后提交 → 分发已拒绝、结果无处投递 → CLI 永远收不到
 * 答案、只能重问同一题;用户每次提交都落进这个循环。这里放宽到 30 分钟(仍留上限
 * 防 waiter 泄漏);更慢的作答由 dispatchMcpCall 的迟到结果通道兜底补投。
 */
export declare const INTERACTIVE_MCP_CALL_TIMEOUT_MS: number;
/**
 * dsh 发起的调用的固定尾注(附在每条 prompt 末端)。
 *
 * CodeBuddy CLI 自带子代理体系(Task/Agent 团队)与自带后台任务(bash
 * run_in_background / docker exec -d),而这条链路里它是被 dsh 拉起的模型
 * 后端:子任务必须交给 dsh 的子代理(委托工具 `dsh_subagent`),长命令必须
 * 走 `dsh_bash`——只有 dsh 通道的任务会进会话树/后台面板,并在完成时唤起
 * 下一轮。尾注同时声明"回合结束后不会自动恢复"的落点:否则模型会承诺
 * "等 X 完成后继续汇报",而外部任务没有完成事件,用户只能主动催。
 * 位置固定在末尾——模型对最新一条输入的尾部指令最敏感。
 */
export declare const DSH_DELEGATION_NOTE: string;
/**
 * MCP 模式(dsh HTTP MCP server)下的固定尾注:与 delegate 版同构,工具名
 * 换成 CLI 呈现的 `mcp__dsh__<工具名>`(参数走各工具的 MCP schema,不再有
 * toolId 中转),并去掉 DelegateTool 形态专属条款。
 */
export declare const MCP_DELEGATION_NOTE: string;
/** 按桥接模式取 prompt 尾注(dsh 运行环境说明)。 */
export declare function promptTailFor(bridgeMode: 'mcp' | 'delegate' | undefined): string;
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
    /**
     * 尝试代次令牌:restart 立即使其失效(与 attempts 不同——attempts 要等
     * 下一次 runAttempt 才 +1,而旧连接的挂起请求会在 restart 之后立刻迟到
     * reject,那段时间里用 attempts 比对拦不住)。
     */
    private attemptToken;
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
    /** prompt 结果里的失败分类(refusal + _meta errorMessage/outcome)。 */
    private promptFailure;
    private agentPhaseSeen;
    private sessionEnded;
    private lastUpdateAt;
    private lastContentAt;
    private tailStartAt;
    /** 疑似卡住诊断的下次打印时刻(节流;0 = 无待打印)。 */
    private nextDiagAt;
    private tailDeadline;
    /** CLI 报"空闲"相位的时间(agentPhase=idle);undefined = 本轮未报过。 */
    private lastIdlePhaseAt;
    /** 最近一次"工具执行中"相位的时间(它算活动;session_info 心跳不算)。 */
    private lastToolExecutingAt;
    /** 收段判定辅助。 */
    private boundarySeenAt;
    /** 边界/收尾的一次性补判定定时器(心跳粒度不够时的精确收口)。 */
    private checkTimer;
    private usageGraceUntil;
    private toolExecutingSeen;
    private firstResultSeen;
    /** steer 轮询。 */
    private lastSteerPoll;
    /** 每条 prompt 的固定尾注(按桥接模式,dsh 运行环境说明)。 */
    private readonly promptTail;
    /** 桥接模式(回放工具的执行语义按它分派,mcp 模式见 ensureReplayTool)。 */
    private readonly bridgeMode;
    /** 泵构造时刻(回合开始):插入水位线在锚点不可用时的兜底。 */
    private readonly constructedAt;
    /** 子代理镜像 / todo 桥。 */
    private readonly mirrors;
    private readonly subagentCallIds;
    /**
     * 真工具直发的 delegate 请求等待器:callId → 等待者。
     * pump 把 delegate 调用发射为真工具块,loop 执行后写 tool/result 事件,
     * onSessionEvent 按 callId 把结果交给等待中的 `_codebuddy.ai/delegateTool`
     * 请求。
     */
    private readonly delegateWaiters;
    /**
     * 已发射但请求还没到的 delegate 块:toolId → 队列(FIFO + args 精确优先)。
     * 请求先于 update 到达时反向登记进 pendingDelegateRequests,由
     * claimDelegateRequest 双向认领。
     */
    private readonly unclaimedDelegates;
    /** 请求先到、块还没发射的 delegate 请求:toolId → 认领回调队列(FIFO + args 精确优先)。 */
    private readonly pendingDelegateRequests;
    /** 结果先到(请求未到)的缓存:callId → 结果,由 awaitDelegateResult 认领。 */
    private readonly delegateResults;
    /** session/event 订阅解绑句柄。 */
    private disposeEventHook;
    /** MCP→loop 转发器的注销句柄(泵生命周期内有效)。 */
    private disposeLoopDispatcher;
    /** steer 在飞防重:同一条消息不等响应完成不重复发起。 */
    private readonly inFlightForwards;
    /**
     * MCP 调用等待:callId → 等待者。dispatchMcpCall 把调用伪装成本步的
     * tool-call 块(独立段)交给 loop 原生执行,tool/result 事件按 callId 回填。
     */
    private readonly mcpWaiters;
    /**
     * 转发超时后仍可能迟到的调用:callId → { 工具名, 迟到投递口 }。
     *
     * 超时不该让结果永久丢失:分发拒绝后 CLI 收到的是超时错误,工具(尤其
     * ask_user_question 这类等真人作答的)稍后完成时,tool/result 到达这里经
     * 投递口补投回会话,CLI 的模型才有机会看到真实结果。
     */
    private readonly lateMcpCalls;
    /**
     * 增量扫描水位:timeline(events 只 append)已处理到的下标;-1 = 未初始化。
     * 早前每轮从锚点全量重扫,长回合里 markForwarded(256 条上限)把最早的
     * 已投 id 挤出后会重复投递旧消息;增量扫描同时解决性能与重投。
     */
    private lastScannedIndex;
    /** 悬挂折叠的短路键(events 长度 + 尾 seq):未变化则复用上轮折叠结果。 */
    private lastFoldKey;
    /** 上轮折叠出的悬挂插入(events 未变化时复用)。 */
    private lastFolded;
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
    /**
     * 以 finish error 收尾(而非抛出):让 agent-loop 走它自己的
     * `agent/request-error` 路径——消息进 LlmError、回合以错误闭合,
     * 与一次性路径的中断语义一致(可重试与否已在泵内决定)。
     */
    private yieldError;
    private isMaxTokens;
    /** 起一次 ACP 进程 + 握手 + prompt(重启路径也走它)。 */
    private runAttempt;
    /**
     * 发一次 `session/prompt`。
     * @returns 请求是否被 CLI 成功处理(false = 连接缺失或请求层失败,供投递
     *   回滚判断——注意 resolve 代表整段 prompt 处理完毕,可能很晚)。
     */
    private sendPrompt;
    /** 回合收尾:断开进程、清空活跃表、唤醒所有等待者。 */
    private finishTurn;
    /** 失败:首段无产出 → 重启;否则整体失败(消费方抛出,loop 收错误回合)。 */
    private failRun;
    /** 重启资格:失败可续跑、仍是首段、本回合无任何产出、还有重试次数。 */
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
    /**
     * 为此 agent 注册一个回放工具(以**工具注册表**为准判重)。
     *
     * 为什么不用进程内 Set 记账(2026-09-18 修):Set 在生产路径从不失效——
     * 一次注册失败(服务未就绪/抛错)或 agent scope 回收重建后工具已不在,而
     * Set 仍说"已注册"→ 该会话的原生工具调用永久报 `unknown tool "cli_read"`
     * (实测:偶发、不可恢复)。直接查注册表则每次都自愈:缺了就补注册,注册
     * 失败下次调用自然重试。
     * @param name - 镜像工具名(cli_ 前缀)。
     * @param nonBlocking - 立即返回占位而非等待 CLI 的 completed(MCP 模式下
     *   仅 DeferExecuteTool 需要:它的真实执行走 MCP 通道,等待会形成
     *   CLI↔MCP↔loop 三方死锁)。
     */
    private ensureReplayTool;
    /**
     * CLI 发来的方法请求:统一入口——`dsh_<工具名>` 的委托工具执行。
     * 返回 undefined 表示本客户端不支持该方法(AcpConnection 会回 -32601)。
     */
    private handleClientRequest;
    private onUpdate;
    /** 单条 update 的状态机(不触发收段判定)。 */
    private applyUpdate;
    /** 订阅会话事件(取 loop 执行真工具后的 tool/result)。 */
    private subscribeSessionEvents;
    /** 会话事件入口:tool/result → 交付等待中的 delegate 请求(或缓存结果)。 */
    private onSessionEvent;
    /** 发射真工具块后,认领可能已挂起的 delegate 请求(请求先到场景)。 */
    private claimDelegateRequest;
    /**
     * MCP 调用转发进 loop(原生执行)。
     *
     * 把外部(MCP 端点)发来的调用伪装成本步的一个工具调用块,**追加进当前打开
     * 的段**后随该段一并收尾——loop 按真实工具名原生执行(审批/沙箱/事件/UI
     * 卡片全原生),tool/result 写入会话时间线并由 onSessionEvent 按 callId
     * 回填 MCP 响应。CLI 模型侧同时从 MCP 通道拿到结果,时间线里的这一步则是
     * "原生记录"。
     *
     * 为什么不能另起独立段(历史竞态,2026-09-13 实测):CLI 的 tools/call(本
     * 方法)与 ACP tool_call 事件先后不定。若本方法先到、只把"无工具调用的旧
     * 段"收尾,loop 会判定"模型输出完成(无工具)"直接 turn/end——独立注入段
     * 永远无人消费(子进程被挂到 300s 超时回落直执),且 CLI 随后的最终答复因
     * 回合已关而无法镜像,整条回答消失。追加进当前段后,该段必然带真工具调用,
     * loop 必定继续执行;镜像回放事件后到时只会另开新段,由后续 step 正常消费。
     * @param name - dsh 真工具名(已由端点做白名单校验)。
     * @param input - 工具参数。
     * @returns 工具结果(文本 + isError + 原始内容块;端点用 content 回传图片)。
     */
    dispatchMcpCall(name: string, input: Record<string, unknown>, lateSink?: (toolName: string, text: string) => void): Promise<DshToolRunResult>;
    /**
     * 等一次真工具直发的 delegate 调用结果。
     * 块已发射 → 直接绑 callId;请求先到 → 挂起等块发射认领;
     * 结果先到 → 取缓存。同 toolId 并发调用优先按参数精确配对(乱序不错配),
     * 无精确匹配时退回队首。abort/dispose 统一拒绝。
     */
    private awaitDelegateResult;
    /** 把等待者绑定到某个 callId(含 abort 清理)。 */
    private bindDelegateWaiter;
    /**
     * 是否 MCP 桥属调用(其真实卡片由注入 loop 的原生调用呈现,镜像应静默)。
     *
     * mcp 模式下两类:CLI 未禁用延迟加载时的 DeferExecuteTool 执行器调用;以及
     * 工具直接展开后的 mcp__dsh__* 直连调用。delegate 模式不该出现这两类名字,
     * 保持原有镜像行为不变。
     */
    private isSuppressedBridgeCall;
    /** 参数完整的工具调用:注册回放工具 → 段内发射 tool-call 块。 */
    private announceCall;
    /** 取(或建)当前打开的段。 */
    private openSegment;
    private closeOpenBlock;
    private closeSegment;
    /** 心跳:steer 轮询 → 看门狗 → 收段判定 → tail 收尾。 */
    private tick;
    /**
     * 疑似卡住时的现场诊断:真实活动静默 >20s 且回合未收尾时,每 30s 打一行
     * 完整状态到日志——"跑完仍显示进行中"类问题据此一眼定位(卡在哪个条件)。
     */
    private diagStuck;
    /** 收段判定:工具边界。 */
    private checkSegmentBoundary;
    /** tail 窗口:prompt 干净收尾后继续抽流(后台任务会自发续跑)。 */
    private checkTail;
    /** 看门狗:静默判死已整体移除——只保留"在途工具永不返回"的硬顶兜底。 */
    private checkStall;
    private stall;
    private armProgress;
    /**
     * 回合内生**所有**未投递的新 user/message → ACP `session/steer`(下一个内部
     * 边界注入)。
     *
     * 对齐官方架构:dsh 原生链路里 agent-loop 每个 step 都重新组装 messages
     * (含本步前新注入的一切——用户插话、子代理结算通知、agent 间消息、插件
     * 上下文:UI 上显示为"上下文注入"),模型每步都看得到。codebuddy 链路的
     * prompt 只在回合开始发一次,回合中途的新消息没有重发通道——实测漏投后果:
     * 子代理做完并结算,主代理同回合内永远收不到通知,一直"等待"到下个回合。
     *
     * 两个来源都要覆盖:inbox 悬挂(next-step 未 claim,毫秒级 step 边界 claim
     * 前就被轮询抢到的窗口)与已 claim 的 `user/message`(timeline 里的正式
     * 消息——claim 发生在 step 边界,1.2s 轮询窗口内几乎必然已被 claim)。
     * 统一按 id 去重(markForwarded):下回合补发时由 skipIds 再兜一次不重复。
     */
    private pollInsertions;
    /** 回合内新注入的水位线:发送锚点之后;锚点不可用时按构造时间。 */
    private insertionFloorIndex;
    /**
     * 单条消息的 steer 投递。
     *
     * markForwarded 只在**确认发出后**才落(steer 成功,或回退 prompt 实际发车):
     * 早前先标记再投递,回合收尾竞态(conn 已散)下消息会「标了已投却从未发出」,
     * 且 skipIds 永久跳过、下回合也不补——通知永久丢。在飞期间用
     * inFlightForwards 防重复发起。
     */
    private steerMessage;
    private replayTodos;
    private emitTodo;
    private landTodo;
    private confirmTodo;
    private maybeStartMirror;
    private finishMirror;
    private waitEvent;
    private wakeAll;
}
