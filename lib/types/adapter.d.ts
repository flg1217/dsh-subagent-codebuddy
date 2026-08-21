/**
 * CodeBuddy 模型适配器:provider 路由 `codebuddy`。
 * 对齐 llm-agy/adapter.ts 的结构:LLM 适配器负责 spawn 上游 + 用翻译模块
 * 产出 StreamChunk;CodeBuddy 的工具步骤落地为子代理会话事件
 * (tool/call + tool/result)。
 * @module subagent-codebuddy/adapter
 */
import type { Context } from '@deepseek-ai/cordis';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm';
/** 适配器配置(由 index.ts 传入)。 */
export interface CodebuddyAdapterOptions {
    /** 可 spawn 的可执行文件(Windows 下已解析为 node + CLI 路径)。 */
    command: string;
    /** 前置参数(如解析出的 CLI 路径)。 */
    prefixArgs: string[];
    /** 读取当前默认模型(调用时求值,设置面板改默认模型后对新请求实时生效)。 */
    modelOf: () => string;
    /** 传给 `--permission-mode` 的权限模式。 */
    permissionMode: string;
    /** 追加的额外 CodeBuddy 参数。 */
    extraArgs: string[];
}
/**
 * CodeBuddy 模型适配器。stream() 每次调用:
 * 序列化 prompt → spawn `codebuddy -p ... --output-format stream-json`
 * → 逐行翻译为 StreamChunk(完整消息,非增量)→ 工具步骤落地为会话事件
 * → usage/finish 收尾。
 *
 * 子代理会话的续聊由 dsh 侧管理:每次调用都把该子代理自己的完整历史
 * 序列化进 prompt,不依赖 CodeBuddy 的会话存储。
 */
export declare class CodebuddyLlmAdapter extends LlmAdapter {
    private readonly ctx;
    private readonly options;
    constructor(ctx: Context, options: CodebuddyAdapterOptions);
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo>;
}
