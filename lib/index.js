/**
 * CodeBuddy CLI 作为 dsh 子代理提供方(ACP 驱动)。
 *
 * 结构对齐 dsh-llm-agy:插件自包含,动态挂载两个官方插件实例——
 *  1. `@deepseek-ai/dsh-subagent-acp`:注册名为 `codebuddy` 的
 *     ctx.subagents 提供方,每次委派 spawn 一个 `codebuddy --acp`
 *     子进程,按 ACP wire 驱动并收集结果;
 *  2. `@deepseek-ai/dsh-tool-subagent`:注册 `subagent_codebuddy`
 *     工具(前台执行,maxDepth: provider-managed——ACP 提供方无法
 *     在本地强制子代理深度)。
 *
 * 能力边界(ACP 语义):子代理是独立运行时,使用 CodeBuddy 自己的
 * 系统提示词、工具面与模型;dsh 侧只传递委派 prompt 文本与工作区
 * cwd(inheritsParentContext: false),并负责子进程环境(凭据 scrub +
 * 显式 env)、权限自动应答与生命周期销毁。
 * @module subagent-codebuddy
 */
import z from '@deepseek-ai/schemastery';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import * as subagentAcpPlugin from '@deepseek-ai/dsh-subagent-acp';
import * as toolSubagentPlugin from '@deepseek-ai/dsh-tool-subagent';
export const name = 'subagent-codebuddy';
export const Config = z.object({
    command: z.string().default('codebuddy'),
    args: z.array(z.string()).default(['--acp']),
    model: z.string().default('deepseek-v4-flash'),
    providerName: z.string().default('codebuddy'),
    toolName: z.string().default('subagent_codebuddy'),
    permission: z.union(['allow', 'reject']).default('reject'),
    cwd: z.string(),
    env: z.dict(z.string()).default({}),
});
/**
 * Windows 下把 `codebuddy` 命令解析为 node 可直接 spawn 的形式。
 * npm 全局安装只生成 `.cmd` shim + shebang 脚本,node 的 spawn 无法
 * 直接执行(ENOENT);解析 shim 拿到真实 JS 入口后用 `node <cli>` 启动。
 * 原生安装(.exe)或显式路径则原样使用。
 * @returns 可 spawn 的 command 与其前置参数。
 */
function resolveSpawnableCommand(command) {
    if (process.platform !== 'win32' || command.includes('/') || command.includes('\\')) {
        return { command, args: [] };
    }
    const findInPath = (name) => {
        for (const dir of (process.env.PATH ?? '').split(';')) {
            if (dir.length === 0)
                continue;
            const full = join(dir, name);
            if (existsSync(full))
                return full;
        }
        return undefined;
    };
    // 原生安装:真实 .exe,直接可用。
    const exe = findInPath(`${command}.exe`);
    if (exe !== undefined)
        return { command: exe, args: [] };
    // npm cmd-shim:读取 shim,取形如 "%dp0%\node_modules\@pkg\bin\cli" 的 JS 入口
    // (shim 里先有 "%dp0%\node.exe" 探测行,取最后一个含 %dp0% 的引号串)。
    const shim = findInPath(`${command}.cmd`) ?? findInPath(command);
    if (shim !== undefined) {
        try {
            const quoted = readFileSync(shim, 'utf8').match(/"([^"]*%dp0%[^"]*)"/gi);
            const match = quoted === null ? undefined : quoted.at(-1)?.match(/"([^"]*)"/);
            if (match !== null && match !== undefined) {
                const cli = match[1].replace(/%dp0%/gi, dirname(shim) + sep);
                if (existsSync(cli))
                    return { command: 'node', args: [cli] };
            }
        }
        catch { /* shim 解析失败,回退原样 */ }
    }
    return { command, args: [] };
}
export function apply(ctx, config) {
    const command = config.command ?? 'codebuddy';
    const providerName = config.providerName ?? 'codebuddy';
    const resolved = resolveSpawnableCommand(command);
    const baseArgs = [...resolved.args, ...(config.args ?? ['--acp'])];
    const model = config.model ?? 'deepseek-v4-flash';
    const args = [...baseArgs, '--model', model];
    const toolName = config.toolName ?? 'subagent_codebuddy';
    // 1. ACP 提供方。挂载整个插件模块对象(带 inject ['subagents','subprocess']),
    //    只传 apply 会丢失注入声明,fiber 加载即失败。
    ctx.plugin(subagentAcpPlugin, {
        providerName,
        command: resolved.command,
        args,
        permission: config.permission ?? 'reject',
        ...config.cwd === undefined ? {} : { cwd: config.cwd },
        env: config.env ?? {},
    });
    // 2. 委派工具。ACP 提供方无 depthLimit 能力,必须 provider-managed;
    //    前台执行(enableRunInBackground: false),与 subagent_codex 行同构。
    ctx.plugin(toolSubagentPlugin, {
        provider: providerName,
        toolName,
        enableRunInBackground: false,
        maxDepth: 'provider-managed',
    });
}
