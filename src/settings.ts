/**
 * CodeBuddy 设置面板支持(服务端):
 * - 模型探测通道:客户端卡片按钮走 api.llm.discoverModels({
 *     settingsNs: 'codebuddy', provider: 'status' | 'test' }),
 *   服务端直接 spawn codebuddy CLI,不落会话、不动源码。
 * - provider 'status' → 检测安装/登录;provider 'test' → 真实连通性测试。
 * @module subagent-codebuddy/settings
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { listCodebuddyModelIds } from './models.js'
import type { Config } from './index.js'

/** 模型探测通道的 settingsNs 键(客户端卡片与之对应)。 */
export const CODEBUDDY_SETTINGS_NAMESPACE = 'codebuddy'

/** 设置表单 schema(与插件 Config 对齐;设置面板可编辑,重启后生效)。 */
export const CodebuddySettingsConfig = z.object({
  command: z.string().default('codebuddy').description('codebuddy 可执行文件命令(默认 codebuddy)'),
  model: z.string().default('deepseek-v4-flash').description('子代理使用的默认模型(委派时可传 model 参数覆盖)'),
  permissionMode: z.string().default('bypassPermissions').description('--permission-mode:子代理工具调用自动放行'),
  registerSubagentTools: z.boolean().default(false).description('提供旧版自定义委派工具(subagent_codebuddy / list_codebuddy_models);默认关闭,推荐用通用 subagent 工具 + 模型选择'),
})

/** 当前生效的 CodeBuddy 配置(表单值优先,插件行配置兜底)。 */
export interface EffectiveCodebuddySettings {
  command: string
  model: string
  permissionMode: string
  registerSubagentTools: boolean
}

/**
 * Windows 下把 `codebuddy` 命令解析为 node 可直接 spawn 的形式。
 * npm 全局安装只生成 `.cmd` shim + shebang 脚本,node 的 spawn 无法
 * 直接执行(ENOENT);解析 shim 拿到真实 JS 入口后用 `node <cli>` 启动。
 * 原生安装(.exe)或显式路径则原样使用。
 * @returns 可 spawn 的 command 与其前置参数。
 */
export function resolveSpawnableCommand(command: string): { command: string; args: string[] } {
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

/** 检测 CodeBuddy 是否已安装(命令存在且可执行)。 */
export function codebuddyInstalled(command: string, prefixArgs: string[]): boolean {
  const r = spawnSync(command, [...prefixArgs, '--version'], { stdio: 'ignore', windowsHide: true })
  return r.error === undefined
}

/**
 * 检测 CodeBuddy 登录状态(启发式)。
 * CLI 没有 auth 状态命令;可靠依据:数据目录 `~/.codebuddy/sessions` 存在
 * 会话记录(说明完成过登录与使用)。会话可能过期,以"测试"按钮结果为准。
 */
export function codebuddyLoggedIn(): boolean {
  const base = join(process.env.USERPROFILE ?? '', '.codebuddy')
  if (!existsSync(base)) return false
  const sessions = join(base, 'sessions')
  if (existsSync(sessions)) {
    try {
      return readdirSync(sessions).some((f) => f.endsWith('.json'))
    } catch { /* 目录读失败按未登录 */ }
  }
  return false
}

/** 发起真实测试:让 CodeBuddy 回答一个真实问题,返回实际回复内容。 */
export function codebuddyTest(command: string, prefixArgs: string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const proc = spawn(command, [
      ...prefixArgs,
      '-p', '请用一句简短的话回答:你好,请介绍一下你自己是谁?',
      '--output-format', 'text',
      '--permission-mode', 'bypassPermissions',
    ], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
    let out = ''
    proc.stdout?.setEncoding('utf8')
    proc.stdout?.on('data', (d: string) => { out += d })
    const killer = setTimeout(() => proc.kill(), 60_000)
    proc.on('close', (code: number | null) => {
      clearTimeout(killer)
      const text = out.trim()
      resolve({ ok: code === 0 && text.length > 0, output: text || `exit ${code}` })
    })
    proc.on('error', (err: Error) => {
      clearTimeout(killer)
      resolve({ ok: false, output: String(err) })
    })
  })
}

/**
 * 注册设置区与模型探测通道(客户端卡片按钮走 api.llm.discoverModels,不落会话)。
 * 设置区是卡片在"设置 → 插件"页出现的前提:该页按 settings namespace
 * 派发卡片(key = namespace);表单值优先于插件行配置,改动后重启生效。
 * @param ctx - 插件上下文。
 * @param config - 插件行配置(兜底值)。
 * @param onSettingsChange - 设置保存后的回调(用于实时同步 opt-in 工具注册)。
 * @returns 读取当前生效配置的函数。
 */
export function registerCodebuddySettings(
  ctx: Context,
  config: Config,
  onSettingsChange?: () => void,
): () => EffectiveCodebuddySettings {
  let current: () => Record<string, unknown> = () => ({})
  // 官方 0.1.2:设置区经 ctx.settings.installSection 注册(NS 为普通字符串)。
  ctx.inject(['settings'], (settingsCtx) => {
    const settings = settingsCtx.get('settings') as {
      installSection?: (
        owner: Context,
        ns: string,
        schema: unknown,
        entry: unknown,
        hooks: { setSource?: (source: () => Record<string, unknown> | undefined) => void; onChange?: () => void },
      ) => void
    } | undefined
    settings?.installSection?.(ctx, CODEBUDDY_SETTINGS_NAMESPACE, CodebuddySettingsConfig, {}, {
      setSource: (source) => {
        current = (() => source() ?? {}) as () => Record<string, unknown>
      },
      onChange: () => onSettingsChange?.(),
    })
  })
  const sectionOf = (): EffectiveCodebuddySettings => {
    const s = current() as Partial<EffectiveCodebuddySettings>
    return {
      command: s.command ?? config.command ?? 'codebuddy',
      model: s.model ?? config.model ?? 'deepseek-v4-flash',
      permissionMode: s.permissionMode ?? config.permissionMode ?? 'bypassPermissions',
      registerSubagentTools: s.registerSubagentTools ?? config.registerSubagentTools ?? false,
    }
  }

  const llm = ctx.get('llm') as
    | { registerModelDiscovery?: (ns: string, fn: (request: { provider?: string }) => Promise<readonly { id: string; name?: string }[]>) => void }
    | undefined
  if (llm?.registerModelDiscovery === undefined) return sectionOf

  llm.registerModelDiscovery(CODEBUDDY_SETTINGS_NAMESPACE, async (request: { provider?: string }) => {
    const section = sectionOf()
    const resolved = resolveSpawnableCommand(section.command)
    const action = request.provider ?? 'status'
    if (action === 'models') {
      // 当前支持的模型 id 列表(客户端卡片"获取所有模型")。
      return listCodebuddyModelIds(resolved.command, resolved.args).map(id => ({ id, name: id }))
    }
    if (action === 'test') {
      const { ok, output } = await codebuddyTest(resolved.command, resolved.args)
      return [{
        id: 'codebuddy-test',
        // 展示 CodeBuddy 的真实回复内容(而非固定 hi);name 必须非空(客户端网关 min(1) 校验)。
        name: ok ? (output.slice(0, 300) || '(空回复)') : `✗ CodeBuddy 测试失败:${output.slice(0, 300)}`,
      }]
    }
    const installed = codebuddyInstalled(resolved.command, resolved.args)
    const loggedIn = installed && codebuddyLoggedIn()
    return [{
      id: 'codebuddy-status',
      name: `CodeBuddy 安装:${installed ? '✓ 已安装' : '✗ 未安装'} | 登录状态:${installed ? (loggedIn ? '✓ 已登录' : '✗ 未登录(以测试为准)') : '-'} | 命令:${section.command}`,
    }]
  })
  return sectionOf
}
