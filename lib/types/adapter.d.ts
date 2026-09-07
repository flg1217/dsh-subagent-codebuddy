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
 * - **假死防御分层**:进展性 update(消息/思考/工具)重置动态空闲阈值;
 *   CLI 心跳(session_info/usage/config)不参与续命;静默超阈值先发
 *   cancel、5s 仍无响应才 kill——进程退出码与 stderr 尾部全程留证。
 * @module subagent-codebuddy/adapter
 */
import type { Context } from '@deepseek-ai/cordis';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { AcpTimeouts } from './acp.js';
/** CodeBuddy CLI 入口(由 index.ts 解析;Windows 下已是 node 可直接执行的 js)。 */
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
}
/**
 * CodeBuddy 模型适配器。stream() 每次调用:
 * spawn `codebuddy --acp` → initialize → session/new(或 session/load 复用)
 * → session/prompt → 消费 session/update(思考/文本/工具)→ finish 收尾。
 * 每次调用一个 ACP 进程,用完退出;会话连续性由 CodeBuddy 会话存储 +
 * session/load 保证(实测回放完整)。
 */
export declare class CodebuddyLlmAdapter extends LlmAdapter {
    private readonly ctx;
    private readonly options;
    /**
     * dsh 子代理会话 → CodeBuddy ACP sessionId。
     *
     * 首次调用 `session/new` 建立并记录;之后同一子代理会话的每次 stream 都
     * `session/load` 载入同一会话(官方实现会先回放历史事件,回放不落地)。
     */
    private readonly conversationIds;
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
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
}
