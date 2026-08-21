/**
 * CodeBuddy 模型适配器:provider 路由 `codebuddy`。
 * 对齐 llm-agy/adapter.ts 的结构:LLM 适配器负责 spawn 上游 + 用翻译模块
 * 产出 StreamChunk;CodeBuddy 的工具步骤落地为子代理会话事件
 * (tool/call + tool/result)。
 * @module subagent-codebuddy/adapter
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { CallId, LlmAdapter, createToolResultMessage } from '@deepseek-ai/dsh-llm';
import { buildPrompt } from './serialize.js';
import { CodebuddyTranslator } from './translate.js';
/** 进程退出兜底:进程卡死时强制结束,保证 stream 一定结束。 */
async function closeWithTimeout(proc, signal, timeoutMs = 30_000) {
    const closePromise = once(proc, 'close');
    let timer;
    if (signal?.aborted) {
        proc.kill();
    }
    else {
        timer = setTimeout(() => {
            proc.kill();
        }, timeoutMs);
    }
    try {
        return await closePromise;
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
    }
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
export class CodebuddyLlmAdapter extends LlmAdapter {
    ctx;
    options;
    constructor(ctx, options) {
        super();
        this.ctx = ctx;
        this.options = options;
    }
    async *stream(options) {
        const { command, prefixArgs, permissionMode } = this.options;
        // 请求级 model 优先(子代理可经 agentOptions.model 动态指定),回退到配置值。
        const model = options.model ?? this.options.model;
        const { prompt, cleanup } = await buildPrompt(this.ctx, options);
        // 工作目录对齐子代理会话的工作区,保证文件操作发生在正确目录。
        const childSession = options.sessionId !== undefined ? this.ctx.get('sessions')?.get(options.sessionId) : undefined;
        const cwd = childSession?.header.cwd ?? process.cwd();
        try {
            const proc = spawn(command, [
                ...prefixArgs,
                '-p', prompt,
                '--output-format', 'stream-json',
                '--permission-mode', permissionMode,
                '--model', model,
                ...this.options.extraArgs,
            ], {
                cwd,
                stdio: ['ignore', 'pipe', 'inherit'],
                windowsHide: true,
            });
            if (proc.stdout === null) {
                proc.kill();
                throw new Error('subagent-codebuddy: codebuddy process has no stdout stream');
            }
            const onAbort = () => { proc.kill(); };
            options.signal?.addEventListener('abort', onAbort, { once: true });
            // 工具步骤落地为会话事件所需的 turn/step(从子代理会话推断)。
            const session = options.sessionId !== undefined ? this.ctx.get('sessions')?.get(options.sessionId) : undefined;
            const events = session?.events ?? [];
            const turn = ([...events].reverse().find(e => e.type === 'turn/start')?.data.turn ?? 1);
            const step = ([...events].reverse().find(e => e.type === 'step/start')?.data.step ?? 1);
            const toolCallSeqs = new Map();
            const translator = new CodebuddyTranslator();
            try {
                proc.stdout.setEncoding('utf8');
                const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
                for await (const line of rl) {
                    if (options.signal?.aborted) {
                        proc.kill();
                        break;
                    }
                    const { chunks, toolSteps } = translator.push(line);
                    for (const chunk of chunks)
                        yield chunk;
                    for (const stepEvent of toolSteps) {
                        if (session === undefined)
                            continue;
                        if (stepEvent.kind === 'tool/call') {
                            const ev = session.append('tool/call', {
                                turn,
                                step,
                                callId: CallId(stepEvent.callId),
                                name: stepEvent.name ?? 'tool',
                                arguments: stepEvent.argumentsJson ?? '{}',
                            });
                            toolCallSeqs.set(stepEvent.callId, ev.seq);
                        }
                        else {
                            const seq = toolCallSeqs.get(stepEvent.callId);
                            session.append('tool/result', {
                                turn,
                                step,
                                message: createToolResultMessage({
                                    callId: CallId(stepEvent.callId),
                                    content: [{ type: 'text', text: stepEvent.outputText ?? '' }],
                                    isError: stepEvent.isError ?? false,
                                }),
                            }, {
                                surfaceOp: 'append',
                                ...(seq !== undefined ? { sourceEventSeqs: [seq] } : {}),
                            });
                        }
                    }
                }
            }
            finally {
                options.signal?.removeEventListener('abort', onAbort);
            }
            await closeWithTimeout(proc, options.signal);
            for (const chunk of translator.end())
                yield chunk;
        }
        finally {
            await cleanup();
        }
    }
    resolveModel(provider, model) {
        return Promise.resolve({
            provider,
            id: model,
            name: model,
            // CodeBuddy 由内置模型驱动,支持文本与图像输入。
            inputModalities: ['text', 'image'],
            context: { contextWindow: 1_000_000 },
        });
    }
}
