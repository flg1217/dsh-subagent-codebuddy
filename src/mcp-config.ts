/**
 * CodeBuddy 方言:MCP 通道的 `--mcp-config` 文件管理。
 *
 * 通用部分(端点注册、key、工具面、执行、图片回传)在共享包
 * `@flg1217/dsh-mcp`;这里只保留 CodeBuddy CLI 特有的落盘形态——CLI 的
 * `--mcp-config <file>` 需要一份会话专属 JSON(URL 含 session/key,供端侧
 * 解析 per-agent 工具集),以及配套的目录约定与陈旧文件清扫。
 *
 * @module subagent-codebuddy/mcp-config
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DSH_MCP_SERVER_NAME, dshMcpEndpointUrl } from '@flg1217/dsh-mcp'

/**
 * `--mcp-config` 文件的落盘目录。
 *
 * 默认系统 temp 下的 `dsh-codebuddy-mcp`;可用环境变量
 * `DSH_CODEBUDDY_MCP_DIR` 覆盖。**测试必须覆盖它**(见
 * `tests/setup-isolate-mcp-dir.ts`):默认目录是**运行中 dsh 服务**正在使用的
 * 真实目录,测试往里写会持续堆积(文件名含每进程随机 key,内容摘要不碰撞)。
 */
function mcpConfigDir(): string {
  const override = process.env['DSH_CODEBUDDY_MCP_DIR']
  if (override !== undefined && override.length > 0) return override
  return join(tmpdir(), 'dsh-codebuddy-mcp')
}

/**
 * 清扫陈旧 `--mcp-config` 文件(插件启动时一次,尽力而为)。
 *
 * 文件按"会话+内容摘要"命名:每进程新 key、端口变化、测试套件运行都会生成
 * 新文件,只增不删会持续堆积;且文件内含端点 key,同用户任意进程可读。阈值
 * 取 1 小时:任何可能仍被在启 CLI 读取的配置都远新于此,多实例/多进程共享
 * 同一 temp 目录时也不会误删在用的文件。
 * @param dir - 目标目录(默认 {@link mcpConfigDir};测试可注入)。
 * @param maxAgeMs - 超过该年龄(毫秒)的文件删除,默认 1 小时。
 * @returns 实际删除的文件数(测试用)。
 */
export function sweepStaleMcpConfigs(dir = mcpConfigDir(), maxAgeMs = 60 * 60 * 1000): number {
  let removed = 0
  try {
    const now = Date.now()
    for (const name of readdirSync(dir)) {
      if (!name.startsWith('mcp-')) continue
      const path = join(dir, name)
      try {
        if (now - statSync(path).mtimeMs > maxAgeMs) {
          rmSync(path, { force: true })
          removed += 1
        }
      } catch { /* 单个文件失败不阻断 */ }
    }
  } catch { /* 目录不存在等:忽略 */ }
  return removed
}

/**
 * 生成会话专属的 `--mcp-config` 文件并返回其路径。
 * @param dshSessionId - 会话 id(URL 携带,端侧据此解析 per-agent 工具集)。
 * @returns 配置文件路径;端点未就绪时 undefined(调用方跳过该参数)。
 */
export function writeDshMcpConfigFile(dshSessionId: string): string | undefined {
  const url = dshMcpEndpointUrl(dshSessionId)
  if (url === undefined) return undefined
  const payload = JSON.stringify({
    mcpServers: {
      [DSH_MCP_SERVER_NAME]: {
        type: 'http',
        url,
        // **全部 dsh 工具直接展开**为 MCP 工具(不延迟加载):模型直接调用
        // mcp__dsh__<工具名>,不再经 ToolSearch / DeferExecuteTool 执行器套壳。
        // 必须显式声明——缺省(false)在 CLI 里会被"全局 defer 开关/产品配置"
        // 覆盖成延迟加载(2026-09-13 实测:未声明时 UI 出现 cli_defer_execute_tool
        // 套壳卡片);显式 false 的优先级高于全局开关。
        defer_loading: false,
      },
    },
  })
  try {
    // 路径含会话与内容摘要:同会话重复 spawn 覆写同一文件,内容变化(如端口)
    // 自动换名,避免读到半旧文件。
    const digest = createHash('sha256').update(payload).digest('hex').slice(0, 8)
    const dir = mcpConfigDir()
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `mcp-${dshSessionId}-${digest}.json`)
    // 0600:文件内含端点 key,默认权限(POSIX 下 0644)会允许同机其他用户读取。
    // Windows 忽略该参数,属无害改进。
    writeFileSync(path, payload, { mode: 0o600 })
    return path
  } catch {
    return undefined
  }
}

/**
 * spawn 参数:bridgeMode **显式等于 `mcp`** 时生成会话专属 MCP 配置并返回
 * `--mcp-config` 参数。
 * @param bridgeMode - 桥接模式(undefined 与 delegate 同义:不注入)。
 * @param dshSessionId - 会话 id(MCP URL 携带,端侧据此解析 per-agent 工具集)。
 * @returns 追加到 CLI argv 的参数(空数组表示不启用 MCP 通道)。
 */
export function mcpConfigArgs(
  bridgeMode: 'mcp' | 'delegate' | undefined,
  dshSessionId: string | undefined,
): string[] {
  // 只有显式 mcp 才注入:undefined 不能再被当作 mcp——低层各处缺省统一按
  // delegate(见 pump.ts this.bridgeMode / serialize 文案),避免"spawn 连了
  // MCP、提示词与注册却按 delegate"的混合态。
  if (bridgeMode !== 'mcp' || dshSessionId === undefined) return []
  const path = writeDshMcpConfigFile(dshSessionId)
  if (path === undefined) {
    // 端点未就绪(webserver 未起)或已被卸载(owner 插件被禁用):CLI 将以
    // "内置工具全禁 + 无 --mcp-config"启动,该回合零工具——显式告警,
    // 不要把这种状态留给现场猜(此前完全静默)。
    console.error('[codebuddy-bridge] mcp 模式拿不到 dsh 端点 URL:跳过 --mcp-config,'
      + '该 CLI 回合将以零工具启动(检查 dsh-mcp 端点是否被卸载/服务未就绪)')
    return []
  }
  return ['--mcp-config', path]
}
