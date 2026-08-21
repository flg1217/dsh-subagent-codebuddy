/**
 * CodeBuddy 可用模型查询工具。
 *
 * CodeBuddy CLI 没有独立的 `models` 子命令,但 `--help` 的 `--model` 选项
 * 描述里自带 "Currently supported: (...)" 列表——spawn `--help` 解析该段,
 * 主代理先查询再以准确的 model id 委派。
 * @module subagent-codebuddy/models
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { spawnSync } from 'node:child_process'

/** 匹配 `--model` 帮助文本里的支持列表,如 "Currently supported: (a, b, c)"。 */
const SUPPORTED_MODELS_RE = /Currently supported:\s*\(([^)]+)\)/

/** 解析 CodeBuddy CLI 的 `--help` 输出,返回当前支持的模型 id 列表文本。 */
export function listCodebuddyModels(command: string, prefixArgs: string[]): string {
  const r = spawnSync(command, [...prefixArgs, '--help'], {
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
  })
  const text = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
  const m = SUPPORTED_MODELS_RE.exec(text)
  if (m === null) {
    const tail = text.trim().split('\n').slice(-3).join('\n')
    return `Could not parse supported models from \`${command} --help\` (exit ${r.status ?? '?'}). Raw output tail:\n${tail}`
  }
  const ids = m[1].split(',').map(s => s.trim()).filter(s => s.length > 0)
  if (ids.length === 0) return 'The CodeBuddy CLI listed no supported models.'
  return ids.map(id => `- ${id}`).join('\n')
}

/** 注册模型查询工具(与 subagent_codebuddy 配套)。 */
export function registerCodebuddyModelsTool(
  ctx: Context,
  options: { command: string; prefixArgs: string[]; toolName: string },
): void {
  ctx.tools.register(defineTool({
    name: options.toolName,
    description:
      'List the model ids currently supported by the CodeBuddy CLI. Call this before delegating when you want a '
      + 'non-default model, then pass one of the returned ids in the `model` argument of subagent_codebuddy.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value as string }],
    },
    isConcurrencySafe: () => true,
    async execute() {
      return listCodebuddyModels(options.command, options.prefixArgs)
    },
  }))
}
