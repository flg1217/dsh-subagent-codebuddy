/**
 * CodeBuddy CLI(Tencent)作为 dsh 的 LLM 提供方(模型供应商模式)。
 *
 * 结构对齐 dsh-llm-agy:
 *  1. 注册 `codebuddy` LLM provider 路由(CodebuddyLlmAdapter,ACP 协议)——
 *     主代理可直接在模型选择器里选用 CodeBuddy 模型(该轮由 CodeBuddy
 *     CLI 全权驱动,用它自己的工具链;dsh 的沙箱/审批不参与);同时
 *     通用 `subagent` 工具可通过 subagent-model-selection 委派
 *     `{provider: codebuddy, model: <id>}` 的进程内子代理。
 *  2. 可选注册自定义委派工具 `subagent_codebuddy` 与 `list_codebuddy_models`
 *     ——工具描述里内置"完整上下文"指引,作为通用工具之外的 opt-in 路径。
 *     开关在**设置面板**(设置 → 插件 → CodeBuddy,`registerSubagentTools`,
 *     默认关闭)实时生效,也可用插件行配置兜底。
 *
 * 模型目录:adapter `listModels()` 解析 `codebuddy --help` 的支持列表,
 * 供主模型选择器与 list_subagent_models 使用(带缓存,永不抛错)。
 * @module subagent-codebuddy
 */
import z from '@deepseek-ai/schemastery';
import { CodebuddyLlmAdapter } from './adapter.js';
import { registerSubagentTool } from './subagent-tool.js';
import { registerCodebuddyModelsTool } from './models.js';
import { registerCodebuddySettings, resolveSpawnableCommand } from './settings.js';
export const name = 'subagent-codebuddy';
// provider 是核心面:仅 `tools`/`subagents`/`systemPrompt` 是 opt-in 工具所需,
// 经 ctx.inject 惰性获取,LLM-only 组合下插件照常加载。
export const inject = ['llm'];
export const Config = z.object({
    command: z.string().default('codebuddy'),
    model: z.string().default('deepseek-v4-flash'),
    permissionMode: z.string().default('bypassPermissions'),
    extraArgs: z.array(z.string()).default([]),
    providerName: z.string().default('codebuddy'),
    toolName: z.string().default('subagent_codebuddy'),
    registerSubagentTools: z.boolean().default(false),
    longToolCapMinutes: z.number().default(30),
});
export function apply(ctx, config) {
    const providerName = config.providerName ?? 'codebuddy';
    const toolName = config.toolName ?? 'subagent_codebuddy';
    // opt-in 工具的注册状态:设置面板开关实时同步(开 → 注册,关 → 注销)。
    let toolCtx;
    let disposers = [];
    // 设置面板通道 + 设置区:卡片显示的前提(该页按 settings namespace 派发卡片);
    // 表单值优先于插件行配置,返回的 thunk 读取当前生效配置。onChange 实时同步工具。
    const settingsOf = registerCodebuddySettings(ctx, config, () => syncTools());
    const eff = settingsOf();
    const resolved = resolveSpawnableCommand(eff.command);
    // LLM provider 路由:主代理选择与子代理委派的推理都走 CodeBuddy。
    ctx.llm.registerAdapter([providerName], new CodebuddyLlmAdapter(ctx, {
        command: resolved.command,
        prefixArgs: resolved.args,
        modelOf: () => settingsOf().model,
        permissionMode: eff.permissionMode,
        extraArgs: config.extraArgs ?? [],
        // 静默长工具硬顶(分钟 → 毫秒;0 = 关闭)。看门狗超顶时 cancel+强杀,走
        // stall 重试自动续跑——防止 CLI 卡死时进程泄漏、子会话回合悬空。
        timeouts: { guardCapMs: (config.longToolCapMinutes ?? 30) * 60_000 },
    }));
    /**
     * opt-in 委派工具:spawn 子代理(进程内、continuable 可续聊),模型路由指
     * 向 codebuddy provider。自定义注册以在工具描述里内置"完整上下文"指引
     * (子代理看不到当前会话、无法追问,委派必须自带全部上下文)。
     */
    function subagentToolOptions() {
        return {
            provider: 'spawn',
            toolName,
            agentOptions: () => ({ provider: providerName, model: settingsOf().model }),
            description: 'Delegate a self-contained task to a CodeBuddy subagent (a separate process running Tencent CodeBuddy with its own tools) '
                + 'to offload focused, independent work — research, a scoped implementation, an analysis — so it does not consume '
                + 'this conversation\'s context. The subagent returns its result, not its intermediate steps.\n\n'
                + 'Provide COMPLETE context for every delegation — the subagent does not see this conversation and cannot ask '
                + 'follow-up questions: (1) the goal and acceptance criteria; (2) exact file/directory paths to touch or inspect; '
                + '(3) constraints and boundaries (what NOT to do, what to preserve); (4) the expected output format. Split complex '
                + 'tasks into independent subagents and run them in parallel. '
                + 'Optionally pass a `model` argument with an exact model id (query `list_codebuddy_models` or the main model '
                + 'selector for the currently supported ids); omit it to use the plugin-configured default model. '
                + 'This tool runs in the background by default: it immediately returns a durable subagent id and keeps the child '
                + 'conversation available for later turns; when the run settles, the runtime sends you a notice containing its '
                + 'outcome and any final assistant message. Set `run_in_background: false` only when your next action depends on '
                + 'receiving the result; `send_message` starts a later turn in the same child conversation.',
            promptDescription: 'The complete, self-contained task for the subagent. It does not share this conversation\'s context, so include '
                + 'everything it needs: the goal, acceptance criteria, exact file paths, constraints, and the expected output format. '
                + 'Always instruct the subagent to keep working until the task is FULLY complete — no interim stop-and-report rounds; '
                + 'it should only stop on a blocking decision that only the user can make. '
                + 'If the task involves starting a dev server or any long-running process, instruct the subagent to run it via '
                + 'Bash with run_in_background: true (never in the foreground — a foreground server never returns and stalls the run).',
        };
    }
    /** 按当前生效设置同步 opt-in 工具注册;服务未就绪时先跳过,注入回调会再同步。 */
    function syncTools() {
        if (toolCtx === undefined)
            return;
        const enabled = settingsOf().registerSubagentTools;
        if (enabled && disposers.length === 0) {
            disposers = [
                registerSubagentTool(toolCtx, subagentToolOptions()),
                registerCodebuddyModelsTool(toolCtx, {
                    command: resolved.command,
                    prefixArgs: resolved.args,
                    toolName: 'list_codebuddy_models',
                }),
            ];
        }
        else if (!enabled && disposers.length > 0) {
            for (const dispose of disposers)
                dispose();
            disposers = [];
        }
    }
    ctx.inject(['tools', 'subagents', 'systemPrompt'], (injected) => {
        toolCtx = injected;
        syncTools();
        return () => {
            for (const dispose of disposers)
                dispose();
            disposers = [];
            toolCtx = undefined;
        };
    });
}
