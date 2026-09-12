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
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
/** 默认动态空闲超时预算:与 agy 执行器同一套算法(无总时长上限)。 */
export const DEFAULT_ACP_RUN_TIMEOUTS = {
    firstMs: 60_000,
    idleMinMs: 150_000,
    idleMaxMs: 600_000,
    idleFactor: 3,
    idleWarmupLines: 6,
    tailQuietMs: 5_000,
    tailBgQuietMs: 10 * 60_000,
    tailCapMs: 30 * 60_000,
};
/**
 * JSON-RPC 级失败:保留错误码与 data(限流/认证/模型服务等分类在 data 里,
 * 压成纯文本就丢失了可分类性)。
 */
export class AcpRpcError extends Error {
    code;
    data;
    constructor(code, message, data) {
        super(message);
        this.code = code;
        this.data = data;
        this.name = 'AcpRpcError';
    }
}
/** 工具名在 _meta 私有扩展里的键。 */
const TOOL_NAME_META_KEY = 'codebuddy.ai/toolName';
/** 从 update 提取 CodeBuddy 私有工具名,并归一化为 dsh 工具名
 * (Read→read、TodoWrite→todo_write、WebSearch→web_search),
 * 让子代理窗口复用 dsh 原生工具的可视化渲染器。 */
export function toolNameOf(update) {
    const name = update._meta?.[TOOL_NAME_META_KEY];
    const raw = typeof name === 'string' && name.length > 0 ? name : update.title ?? 'tool';
    return raw
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/[-\s]+/g, '_')
        .toLowerCase();
}
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
export function usageOfUpdate(update) {
    const payload = update._meta?.['usage'] ?? update._meta?.['codebuddy.ai/usage'];
    if (typeof payload !== 'object' || payload === null)
        return undefined;
    const record = payload;
    const number = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
    const details = (key) => {
        const value = record[key];
        return typeof value === 'object' && value !== null ? value : undefined;
    };
    const prompt = number(record['prompt_tokens']) ?? 0;
    const hit = number(record['prompt_cache_hit_tokens'])
        ?? number(details('prompt_tokens_details')?.['cached_tokens'])
        ?? number(record['cache_read_input_tokens'])
        ?? 0;
    const input = number(record['prompt_cache_miss_tokens']) ?? Math.max(0, prompt - hit);
    const output = number(record['completion_tokens']) ?? 0;
    if (prompt === 0 && output === 0 && hit === 0)
        return undefined;
    const total = number(record['total_tokens']);
    const cacheWrite = number(record['cache_creation_input_tokens']) ?? number(record['prompt_cache_write_tokens']);
    const reasoning = number(details('completion_tokens_details')?.['reasoning_tokens']);
    return {
        inputTokens: input,
        outputTokens: output,
        ...(total === undefined ? {} : { totalTokens: total }),
        ...(hit === 0 ? {} : { cacheReadTokens: hit }),
        ...(cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite }),
        ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
    };
}
/** 进展性事件:代表任务真实推进,重置动态空闲计时。 */
export function isProgressUpdate(update) {
    return update.sessionUpdate === 'agent_message_chunk'
        || update.sessionUpdate === 'agent_thought_chunk'
        || update.sessionUpdate === 'tool_call'
        || update.sessionUpdate === 'tool_call_update';
}
/** JSON-RPC error 对象 → AcpRpcError(保留 code 与 data)。 */
function toRpcError(raw) {
    const error = (raw !== null && typeof raw === 'object' ? raw : {});
    const data = error.data !== null && typeof error.data === 'object' && !Array.isArray(error.data)
        ? error.data
        : undefined;
    const message = typeof error.message === 'string' && error.message.length > 0 ? error.message : 'error';
    return new AcpRpcError(typeof error.code === 'number' ? error.code : undefined, `ACP ${message}`, data);
}
/** 一个 ACP 进程连接:JSON-RPC 请求/通知 + update 事件回调。 */
export class AcpConnection {
    onUpdate;
    onClientRequest;
    proc;
    nextId = 1;
    pending = new Map();
    exitInfo;
    exitWaiters = [];
    /** stderr 尾部(错误归因证据;只收集,不参与任何续命判定)。 */
    stderrTail = '';
    /** close 原因:正常退出 / 被主动 kill(避免把自杀报成崩溃)。 */
    killed = false;
    constructor(argvPrefix, cwd, onUpdate, onClientRequest) {
        this.onUpdate = onUpdate;
        this.onClientRequest = onClientRequest;
        // argvPrefix[0] 是可执行(如 node 或 CLI .exe),其余是前置参数(CLI 路径等)。
        this.proc = spawn(argvPrefix[0], [...argvPrefix.slice(1)], {
            cwd,
            // stdin 管道(发 JSON-RPC);stdout/stderr 管道(协议流 + 归因证据)。
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });
        const rl = createInterface({ input: this.proc.stdout, crlfDelay: Infinity });
        rl.on('line', line => {
            if (!line.trim().startsWith('{'))
                return;
            let msg;
            try {
                msg = JSON.parse(line);
            }
            catch {
                return;
            }
            if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
                const p = this.pending.get(msg.id);
                if (p !== undefined) {
                    this.pending.delete(msg.id);
                    if (msg.error !== undefined)
                        p.reject(toRpcError(msg.error));
                    else
                        p.resolve(msg.result);
                }
                return;
            }
            // CLI → 客户端的请求(extMethod):先于通知判定——它带 id 且带 method。
            if (msg.id !== undefined && msg.method !== undefined) {
                void this.answerClientRequest(msg.id, msg.method, msg.params);
                return;
            }
            const update = msg.params?.update;
            if (update !== undefined) {
                // 单条坏 update 不该拖垮整个服务:状态机异常由回合超时/恢复路径兜底。
                try {
                    this.onUpdate(update);
                }
                catch (error) {
                    console.error('[codebuddy-acp] update handler failed:', error);
                }
            }
        });
        this.proc.stderr?.setEncoding('utf8');
        this.proc.stderr?.on('data', (chunk) => {
            this.stderrTail = (this.stderrTail + chunk).slice(-4000);
        });
        // 进程退出后的 stdin 写入产生 EPIPE(异步 'error' 事件)——没有监听器时
        // 会升级为 uncaughtException 拖垮整个 dsh 服务;这里吞掉(写入由调用方
        // 的 try/catch 与 request 超时兜底)。
        this.proc.stdin?.on('error', () => { });
        this.proc.on('close', (code, signal) => {
            this.exitInfo = { code, signal: signal ?? null };
            // 进程退出时 reject 所有未决请求,避免悬挂到超时。
            for (const p of [...this.pending.values()])
                p.reject(new Error('ACP 进程已退出'));
            this.pending.clear();
            for (const w of this.exitWaiters.splice(0))
                w(this.exitInfo);
        });
    }
    /** 进程退出(含退出码);已在退出后调用则立即返回。 */
    onExit(listener) {
        if (this.exitInfo !== undefined)
            listener(this.exitInfo);
        else
            this.exitWaiters.push(listener);
    }
    /**
     * 发起一次 JSON-RPC 请求。
     * @param timeoutMs 超时毫秒;**<= 0 表示不设请求超时**——`session/prompt`
     * 这类长活请求(整个任务期间)必须传 0,它的生命周期由动态空闲超时
     * (cancel → kill → 进程退出 reject)与 abort 保护,固定超时会误杀长任务
     * (实测:默认 180s 把 3 分钟以上的子代理任务全部掐死)。
     */
    request(method, params, timeoutMs = 180_000) {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            let timer;
            if (timeoutMs > 0) {
                timer = setTimeout(() => {
                    this.pending.delete(id);
                    reject(new Error(`ACP ${method} 超时(${Math.round(timeoutMs / 1000)}s)${this.stderrNote()}`));
                }, timeoutMs);
            }
            this.pending.set(id, {
                resolve: v => { if (timer !== undefined)
                    clearTimeout(timer); resolve(v); },
                reject: e => { if (timer !== undefined)
                    clearTimeout(timer); reject(e); },
            });
            this.proc.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        });
    }
    notify(method, params) {
        this.proc.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    }
    /**
     * 应答 CLI 发来的方法请求(extMethod)。
     * 没有处理器 ≥ 不支持的方法回 -32601,处理器抛错回 -32000——
     * CLI 侧等待的是响应,静默丢弃会让对方卡到自己的超时。
     */
    async answerClientRequest(id, method, params) {
        const record = params !== null && typeof params === 'object' && !Array.isArray(params)
            ? params
            : {};
        let result;
        try {
            result = await this.onClientRequest?.({ method, params: record });
        }
        catch (error) {
            this.replyJson({ jsonrpc: '2.0', id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
            return;
        }
        if (result === undefined) {
            this.replyJson({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not supported by client: ${method}` } });
            return;
        }
        this.replyJson({ jsonrpc: '2.0', id, result: result ?? {} });
    }
    /** 写一行 JSON 到 CLI stdin(进程已退出的写入静默丢弃)。 */
    replyJson(payload) {
        try {
            this.proc.stdin?.write(JSON.stringify(payload) + '\n');
        }
        catch { /* 进程已退出 */ }
    }
    /** stderr 尾部(有内容才带分号前缀)。 */
    stderrNote() {
        const tail = this.stderrTail.trim();
        return tail.length > 0 ? `;stderr: ${tail.slice(-500)}` : '';
    }
    /** 主动终止:标记自杀,避免 close 被误判为崩溃。 */
    kill() {
        this.killed = true;
        try {
            this.proc.kill();
        }
        catch { /* 已退出 */ }
        try {
            this.proc.stdout?.destroy();
        }
        catch { /* 已关闭 */ }
        try {
            this.proc.stdin?.destroy();
        }
        catch { /* 已关闭 */ }
    }
    get wasKilled() { return this.killed; }
}
