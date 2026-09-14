/**
 * 测试隔离:`--mcp-config` 的落盘目录改到本测试文件专属的临时目录。
 *
 * 背景(2026-09-13 实测):`mcpConfigDir()` 默认指向系统 temp 下的
 * `dsh-codebuddy-mcp`,那是**正在运行的 dsh 服务**正在使用的真实目录。测试若不
 * 隔离会有两个副作用:
 *  1. **污染**:每次 `makeHarness` 都会写一个配置文件;文件名含每进程随机 key,
 *     内容摘要不会碰撞 → 每轮测试新增若干文件,只增不减(实测累积 60+ 个
 *     `mcp-sess-ok-*` / `mcp-sess-x-*`)。真正属于服务的只有 `mcp-session-<uuid>-*`。
 *  2. **清扫生产目录**:`registerDshMcpServer` 会调用 `sweepStaleMcpConfigs()`,
 *     作用于该默认目录。虽然配置文件是"每次 spawn 重写、CLI 启动时读一次",
 *     删掉陈旧文件对在跑的服务无害(下一次 spawn 会重建),但测试去清扫生产
 *     目录本身就不该发生。
 *
 * 覆盖后测试的写入与清扫都局限在一次性目录里,`afterAll` 回收。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'

const isolatedDir = mkdtempSync(join(tmpdir(), 'dsh-mcp-test-'))
process.env['DSH_CODEBUDDY_MCP_DIR'] = isolatedDir

afterAll(() => {
  rmSync(isolatedDir, { recursive: true, force: true })
})
