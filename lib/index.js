/**
 * CodeBuddy CLI 作为 dsh 子代理提供方(LLM 适配器架构)。
 *
 * 结构对齐 dsh-llm-agy:
 *  1. 注册 `codebuddy` LLM provider 路由(CodebuddyLlmAdapter)——每次
 *     子代理 LLM 调用 spawn `codebuddy -p --output-format stream-json`,
 *     翻译文本与工具步骤回 dsh;
 *  2. 挂载 `@deepseek-ai/dsh-tool-subagent` 实例(provider: spawn,
 *     backgroundMode: continuable)——子代理是 dsh 进程内 agent,
 *     会话可常驻、`send_message` 可续聊;推理由 CodeBuddy 完成。
 *
 * 与"ACP 直接子代理"方案的区别:
 * - 每个子代理是独立 dsh 会话,并行子代理互不干扰、可分别续聊;
 * - 每次调用把该子代理自己的完整历史序列化进 prompt(不依赖
 *   CodeBuddy 按 cwd 自动续上下文的存储,无跨任务串味);
 * - 子代理仍由 CodeBuddy 驱动其自带工具,步骤回传 dsh 会话事件。
 * @module subagent-codebuddy
 */
import z from '@deepseek-ai/schemastery';
import { CodebuddyLlmAdapter } from './adapter.js';
import { registerSubagentTool } from './subagent-tool.js';
import { registerCodebuddyModelsTool } from './models.js';
import { registerCodebuddySettings, resolveSpawnableCommand } from './settings.js';
export const name = 'subagent-codebuddy';
export const inject = ['llm', 'tools', 'subagents', 'systemPrompt'];
export const Config = z.object({
    command: z.string().default('codebuddy'),
    model: z.string().default('deepseek-v4-flash'),
    permissionMode: z.string().default('bypassPermissions'),
    extraArgs: z.array(z.string()).default([]),
    providerName: z.string().default('codebuddy'),
    toolName: z.string().default('subagent_codebuddy'),
    registerSubagentTools: z.boolean().default(true),
});
export function apply(ctx, config) {
    const providerName = config.providerName ?? 'codebuddy';
    const toolName = config.toolName ?? 'subagent_codebuddy';
    // 设置面板通道 + 设置区:卡片显示的前提(该页按 settings namespace 派发卡片);
    // 表单值优先于插件行配置,返回的 thunk 读取当前生效配置。
    const settingsOf = registerCodebuddySettings(ctx, config);
    const eff = settingsOf();
    const model = eff.model;
    const resolved = resolveSpawnableCommand(eff.command);
    // 1. LLM provider 路由:子代理的推理走 CodeBuddy。
    ctx.llm.registerAdapter([providerName], new CodebuddyLlmAdapter(ctx, {
        command: resolved.command,
        prefixArgs: resolved.args,
        modelOf: () => settingsOf().model,
        permissionMode: eff.permissionMode,
        extraArgs: config.extraArgs ?? [],
    }));
    // 2. 委派工具:spawn 子代理(进程内、continuable 可续聊),模型路由指
    //    向 codebuddy provider。自定义注册以在工具描述里内置"完整上下文"
    //    指引(子代理看不到当前会话、无法追问,委派必须自带全部上下文)。
    if (config.registerSubagentTools !== false) {
        registerSubagentTool(ctx, {
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
                + 'Optionally pass a `model` argument with an exact model id (query `list_codebuddy_models` for the '
                + 'currently supported ids); omit it to use the plugin-configured default model. '
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
        });
        // 模型查询工具:委派前可先确认当前支持的模型 id。
        registerCodebuddyModelsTool(ctx, {
            command: resolved.command,
            prefixArgs: resolved.args,
            toolName: 'list_codebuddy_models',
        });
    }
}
