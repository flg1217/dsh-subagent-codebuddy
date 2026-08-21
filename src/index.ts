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

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { CodebuddyLlmAdapter } from './adapter.js'
import { registerSubagentTool } from './subagent-tool.js'
import { registerCodebuddyModelsTool } from './models.js'

export const name = 'subagent-codebuddy'
export const inject = ['llm', 'tools', 'subagents', 'systemPrompt']

export interface Config {
  /** 可执行文件,默认 `codebuddy`。 */
  command?: string
  /** 子代理使用的 CodeBuddy 模型 ID,默认 `deepseek-v4-flash`。 */
  model?: string
  /**
   * 传给 `--permission-mode` 的权限模式,默认 `bypassPermissions`
   * (子代理工具调用自动放行,不询问)。
   */
  permissionMode?: string
  /** 追加的额外 CodeBuddy 参数。 */
  extraArgs?: string[]
  /** LLM provider 路由名,默认 `codebuddy`。 */
  providerName?: string
  /** 工具名,默认 `subagent_codebuddy`。 */
  toolName?: string
  /** 是否注册委派工具(默认开启)。 */
  registerSubagentTools?: boolean
}

export const Config: z<Config> = z.object({
  command: z.string().default('codebuddy'),
  model: z.string().default('deepseek-v4-flash'),
  permissionMode: z.string().default('bypassPermissions'),
  extraArgs: z.array(z.string()).default([]),
  providerName: z.string().default('codebuddy'),
  toolName: z.string().default('subagent_codebuddy'),
  registerSubagentTools: z.boolean().default(true),
})

/**
 * Windows 下把 `codebuddy` 命令解析为 node 可直接 spawn 的形式。
 * npm 全局安装只生成 `.cmd` shim + shebang 脚本,node 的 spawn 无法
 * 直接执行(ENOENT);解析 shim 拿到真实 JS 入口后用 `node <cli>` 启动。
 * 原生安装(.exe)或显式路径则原样使用。
 * @returns 可 spawn 的 command 与其前置参数。
 */
function resolveSpawnableCommand(command: string): { command: string; args: string[] } {
  if (process.platform !== 'win32' || command.includes('/') || command.includes('\\')) {
    return { command, args: [] }
  }
  const findInPath = (name: string): string | undefined => {
    for (const dir of (process.env.PATH ?? '').split(';')) {
      if (dir.length === 0) continue
      const full = join(dir, name)
      if (existsSync(full)) return full
    }
    return undefined
  }
  // 原生安装:真实 .exe,直接可用。
  const exe = findInPath(`${command}.exe`)
  if (exe !== undefined) return { command: exe, args: [] }
  // npm cmd-shim:读取 shim,取形如 "%dp0%\node_modules\@pkg\bin\cli" 的 JS 入口
  // (shim 里先有 "%dp0%\node.exe" 探测行,取最后一个含 %dp0% 的引号串)。
  const shim = findInPath(`${command}.cmd`) ?? findInPath(command)
  if (shim !== undefined) {
    try {
      const quoted = readFileSync(shim, 'utf8').match(/"([^"]*%dp0%[^"]*)"/gi)
      const match = quoted === null ? undefined : quoted.at(-1)?.match(/"([^"]*)"/)
      if (match !== null && match !== undefined) {
        const cli = match[1].replace(/%dp0%/gi, dirname(shim) + sep)
        if (existsSync(cli)) return { command: 'node', args: [cli] }
      }
    } catch { /* shim 解析失败,回退原样 */ }
  }
  return { command, args: [] }
}

export function apply(ctx: Context, config: Config): void {
  const providerName = config.providerName ?? 'codebuddy'
  const model = config.model ?? 'deepseek-v4-flash'
  const toolName = config.toolName ?? 'subagent_codebuddy'
  const resolved = resolveSpawnableCommand(config.command ?? 'codebuddy')

  // 1. LLM provider 路由:子代理的推理走 CodeBuddy。
  ctx.llm.registerAdapter([providerName], new CodebuddyLlmAdapter(ctx, {
    command: resolved.command,
    prefixArgs: resolved.args,
    model,
    permissionMode: config.permissionMode ?? 'bypassPermissions',
    extraArgs: config.extraArgs ?? [],
  }))

  // 2. 委派工具:spawn 子代理(进程内、continuable 可续聊),模型路由指
  //    向 codebuddy provider。自定义注册以在工具描述里内置"完整上下文"
  //    指引(子代理看不到当前会话、无法追问,委派必须自带全部上下文)。
  if (config.registerSubagentTools !== false) {
    registerSubagentTool(ctx, {
      provider: 'spawn',
      toolName,
      agentOptions: { provider: providerName, model },
      description:
        'Delegate a self-contained task to a CodeBuddy subagent (a separate process running Tencent CodeBuddy with its own tools) '
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
      promptDescription:
        'The complete, self-contained task for the subagent. It does not share this conversation\'s context, so include '
        + 'everything it needs: the goal, acceptance criteria, exact file paths, constraints, and the expected output format.',
    })
    // 模型查询工具:委派前可先确认当前支持的模型 id。
    registerCodebuddyModelsTool(ctx, {
      command: resolved.command,
      prefixArgs: resolved.args,
      toolName: 'list_codebuddy_models',
    })
  }
}
