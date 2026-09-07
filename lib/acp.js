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
};
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
/** 进展性事件:代表任务真实推进,重置动态空闲计时。 */
export function isProgressUpdate(update) {
    return update.sessionUpdate === 'agent_message_chunk'
        || update.sessionUpdate === 'agent_thought_chunk'
        || update.sessionUpdate === 'tool_call'
        || update.sessionUpdate === 'tool_call_update';
}
/** 一个 ACP 进程连接:JSON-RPC 请求/通知 + update 事件回调。 */
export class AcpConnection {
    onUpdate;
    proc;
    nextId = 1;
    pending = new Map();
    exitInfo;
    exitWaiters = [];
    /** stderr 尾部(错误归因证据;只收集,不参与任何续命判定)。 */
    stderrTail = '';
    /** close 原因:正常退出 / 被主动 kill(避免把自杀报成崩溃)。 */
    killed = false;
    constructor(argvPrefix, cwd, onUpdate) {
        this.onUpdate = onUpdate;
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
                        p.reject(new Error(`ACP ${String(msg.error.message ?? 'error')}`));
                    else
                        p.resolve(msg.result);
                }
                return;
            }
            const update = msg.params?.update;
            if (update !== undefined)
                this.onUpdate(update);
        });
        this.proc.stderr?.setEncoding('utf8');
        this.proc.stderr?.on('data', (chunk) => {
            this.stderrTail = (this.stderrTail + chunk).slice(-4000);
        });
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
    }
    get wasKilled() { return this.killed; }
}
