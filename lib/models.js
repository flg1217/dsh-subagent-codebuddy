/**
 * CodeBuddy 可用模型查询。
 *
 * CodeBuddy CLI 没有独立的 `models` 子命令,但 `--help` 的 `--model` 选项
 * 描述里自带 "Currently supported: (...)" 列表——spawn `--help` 解析该段。
 * 解析结果既是 opt-in 查询工具的数据源,也是 adapter `listModels()` 的目录
 * 来源(主代理模型选择器)。
 * @module subagent-codebuddy/models
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { spawn, spawnSync } from 'node:child_process';
/** 匹配 `--model` 帮助文本里的支持列表,如 "Currently supported: (a, b, c)"。 */
const SUPPORTED_MODELS_RE = /Currently supported:\s*\(([^)]+)\)/;
/** 从 `--help` 文本解析支持的模型 id 列表(空 = 解析失败)。 */
export function parseCodebuddyModelIds(helpText) {
    const m = SUPPORTED_MODELS_RE.exec(helpText);
    if (m === null)
        return [];
    return m[1].split(',').map(s => s.trim()).filter(s => s.length > 0);
}
/** 同步查询 CodeBuddy CLI 的 `--help`,返回支持的模型 id 列表。 */
export function listCodebuddyModelIds(command, prefixArgs) {
    const r = spawnSync(command, [...prefixArgs, '--help'], {
        encoding: 'utf8',
        timeout: 15_000,
        windowsHide: true,
    });
    return parseCodebuddyModelIds(`${r.stdout ?? ''}\n${r.stderr ?? ''}`);
}
/**
 * 异步查询模型 id(不阻塞事件循环,供 adapter `listModels()` 的目录路径)。
 * 失败/超时/解析不到时返回空数组,由调用方决定回退策略。
 */
export function listCodebuddyModelIdsAsync(command, prefixArgs, timeoutMs = 15_000) {
    return new Promise(resolve => {
        let settled = false;
        const finish = (ids) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve(ids);
        };
        let stdout = '';
        let stderr = '';
        let child;
        try {
            child = spawn(command, [...prefixArgs, '--help'], { windowsHide: true });
        }
        catch {
            resolve([]);
            return;
        }
        const timer = setTimeout(() => {
            try {
                child.kill();
            }
            catch { /* 已退出 */ }
            finish([]);
        }, timeoutMs);
        child.stdout?.on('data', (d) => { stdout += String(d); });
        child.stderr?.on('data', (d) => { stderr += String(d); });
        child.on('error', () => finish([]));
        child.on('close', () => finish(parseCodebuddyModelIds(`${stdout}\n${stderr}`)));
    });
}
/** 解析 CodeBuddy CLI 的 `--help` 输出,返回当前支持的模型 id 列表文本。 */
export function listCodebuddyModels(command, prefixArgs) {
    const ids = listCodebuddyModelIds(command, prefixArgs);
    if (ids.length > 0)
        return ids.map(id => `- ${id}`).join('\n');
    const r = spawnSync(command, [...prefixArgs, '--help'], {
        encoding: 'utf8',
        timeout: 15_000,
        windowsHide: true,
    });
    const text = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
    const tail = text.trim().split('\n').slice(-3).join('\n');
    return `Could not parse supported models from \`${command} --help\` (exit ${r.status ?? '?'}). Raw output tail:\n${tail}`;
}
/** 注册模型查询工具(与 subagent_codebuddy 配套;默认关闭的 opt-in 面)。返回注销函数。 */
export function registerCodebuddyModelsTool(ctx, options) {
    return ctx.tools.register(defineTool({
        name: options.toolName,
        description: 'List the model ids currently supported by the CodeBuddy CLI. The generic subagent tool also accepts '
            + 'provider "codebuddy" with any of these ids (subject to the subagent model-selection settings); use this '
            + 'tool when you need the exact id list for a subagent_codebuddy delegation.',
        parameters: {},
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        isConcurrencySafe: () => true,
        async execute() {
            return listCodebuddyModels(options.command, options.prefixArgs);
        },
    }));
}
