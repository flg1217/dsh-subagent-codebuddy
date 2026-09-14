/**
 * dsh MCP server 测试:端点 handler(真 HTTP)+ --mcp-config 生成。
 */
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  DSH_MCP_ENDPOINT_PATH,
  McpDispatchTimeoutError,
  mcpConfigArgs,
  registerDshMcpServer,
  registerMcpLoopDispatcher,
  sweepStaleMcpConfigs,
} from '../src/mcp-server.ts'
import { CLI_TOOL_CALL_TIMEOUT_S, MCP_CALL_TIMEOUT_MS } from '../src/pump.ts'

interface McpTestHarness {
  server: Server
  baseUrl: string
  key: string
  executeCalls: Array<Record<string, unknown>>
  close: () => Promise<void>
}

/** 起一个真 HTTP server,把 MCP handler 挂上(绕过 webserver 服务)。 */
async function makeHarness(options: { toolsExecuteError?: boolean } = {}): Promise<McpTestHarness> {
  const executeCalls: Array<Record<string, unknown>> = []
  const toolsFace = {
    schemas: () => [
      { name: 'bash', description: 'Run a command.', parameters: { type: 'object', properties: { command: { type: 'string' } } } },
      { name: 'cli_read', description: 'mirror noise', parameters: {} },
      { name: 'mcp__x__y', description: 'mcp noise', parameters: {} },
    ],
    execute: async (call: Record<string, unknown>) => {
      executeCalls.push(call)
      if (options.toolsExecuteError === true) throw new Error('sandbox denied')
      return { isError: false, content: [{ type: 'text', text: 'executed!' }] }
    },
  }
  const agentsFace = { get: (id: string) => (id === 'sess-ok' ? { id } : undefined) }
  let routeHandler: ((req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void | Promise<void>) | undefined
  const ctx = {
    get: (key: string): unknown => {
      if (key === 'tools') return toolsFace
      if (key === 'agents') return agentsFace
      return undefined
    },
    // 模拟 cordis 的 inject:同步调用回调,并把回调**返回值**当作 disposer
    // 挂到 inject 子 fiber 上(生产代码依赖这一语义做清理)。
    inject: (_deps: string[], fn: (injected: Context) => (() => void) | void): { dispose: () => void } => {
      const disposer = fn({
        get: (key: string): unknown => key === 'webServer'
          ? {
              register: (route: { path: string; handler: typeof routeHandler }) => {
                routeHandler = route.handler
                return () => { routeHandler = undefined }
              },
              port: 0,
            }
          : undefined,
      } as unknown as Context)
      return { dispose: () => { disposer?.() } }
    },
  } as unknown as Context
  // 保存释放句柄:afterEach 必须释放,否则模块级 endpoint 会跨用例残留
  // (此前用例隐含依赖执行顺序,单独跑就失败)。
  disposeServer = registerDshMcpServer(ctx)
  expect(routeHandler).toBeDefined()
  const handler = routeHandler!
  const server = createServer((req, res) => { void handler(req, res) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as AddressInfo).port
  // 取 key:与 writeDshMcpConfigFile 同源(经配置文件读出 URL)。
  const configPath = mcpConfigArgs('mcp', 'sess-ok')[1]!
  const url = new URL((JSON.parse(readFileSync(configPath, 'utf8')) as {
    mcpServers: { dsh: { url: string } }
  }).mcpServers.dsh.url)
  const key = url.searchParams.get('key')!
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}${DSH_MCP_ENDPOINT_PATH}`,
    key,
    executeCalls,
    close: async () => { await new Promise<void>(resolve => server.close(() => resolve())) },
  }
}

let harness: McpTestHarness | undefined
let disposeServer: (() => void) | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
  disposeServer?.()
  disposeServer = undefined
})

async function rpc(h: McpTestHarness, body: unknown, query = `session=sess-ok&key=${h.key}`): Promise<{ status: number; json?: Record<string, unknown> }> {
  const response = await fetch(`${h.baseUrl}?${query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  let json: Record<string, unknown> | undefined
  if (text.length > 0) {
    try {
      json = JSON.parse(text) as Record<string, unknown>
    } catch { /* 403/413 等为纯文本响应 */ }
  }
  return { status: response.status, ...(json === undefined ? {} : { json }) }
}

describe('dsh MCP server:JSON-RPC over HTTP', () => {
  it('initialize 协商版本并声明 tools 能力', async () => {
    harness = await makeHarness()
    const { status, json } = await rpc(harness, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {} },
    })
    expect(status).toBe(200)
    expect(json?.['result']).toMatchObject({
      protocolVersion: '2025-03-26',
      capabilities: { tools: {} },
      serverInfo: { name: 'dsh-harness' },
    })
  })

  it('tools/list 现取 schemas:排除镜像/自带 mcp 工具,保留完整 inputSchema', async () => {
    harness = await makeHarness()
    const { json } = await rpc(harness, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const tools = (json?.['result'] as { tools: Array<Record<string, unknown>> }).tools
    expect(tools.map(tool => tool['name'])).toEqual(['bash'])
    expect(tools[0]!['inputSchema']).toEqual({
      type: 'object',
      properties: { command: { type: 'string' } },
    })
  })

  it('tools/call 走 dsh 工具管线并按 MCP 形状返回;未知工具报 isError', async () => {
    harness = await makeHarness()
    const ok = await rpc(harness, {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'bash', arguments: { command: 'echo hi' } },
    })
    expect(ok.json?.['result']).toEqual({ content: [{ type: 'text', text: 'executed!' }] })
    expect(harness.executeCalls[0]).toMatchObject({ name: 'bash', arguments: { command: 'echo hi' } })

    const bad = await rpc(harness, {
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'cli_read', arguments: {} },
    })
    expect((bad.json?.['result'] as { isError?: boolean }).isError).toBe(true)
  })

  it('tools/call 可见性:命名合法但不在本会话工具面内的工具被拒绝(回归)', async () => {
    harness = await makeHarness()
    // 'write' 命名合法(isBridgeEligible 通过),但 harness 的 schemas 只暴露
    // 'bash' —— 必须按 tools/list 的口径拒绝,不能只查命名形态(否则持有 key
    // 的调用方可绕过 per-agent scope)。
    const denied = await rpc(harness, {
      jsonrpc: '2.0', id: 20, method: 'tools/call',
      params: { name: 'write', arguments: { file_path: 'x', content: 'y' } },
    })
    const result = denied.json?.['result'] as { isError?: boolean; content?: { text?: string }[] }
    expect(result.isError).toBe(true)
    expect(result.content?.[0]?.text).toContain('不可见')
    // 关键:越权调用不得落到直执通道。
    expect(harness.executeCalls).toHaveLength(0)
  })

  it('tools/call 会话无活跃 agent → 拒绝(不再回落直执)', async () => {
    harness = await makeHarness()
    const denied = await rpc(harness, {
      jsonrpc: '2.0', id: 21, method: 'tools/call',
      params: { name: 'bash', arguments: { command: 'x' } },
    }, `session=sess-missing&key=${harness.key}`)
    const result = denied.json?.['result'] as { isError?: boolean; content?: { text?: string }[] }
    expect(result.isError).toBe(true)
    expect(result.content?.[0]?.text).toContain('没有活跃的 agent')
    expect(harness.executeCalls).toHaveLength(0)
  })

  it('initialize 只回服务端支持的协议版本(不谎称支持客户端版本)', async () => {
    harness = await makeHarness()
    const known = await rpc(harness, {
      jsonrpc: '2.0', id: 22, method: 'initialize',
      params: { protocolVersion: '2025-03-26' },
    })
    expect((known.json?.['result'] as { protocolVersion?: string }).protocolVersion).toBe('2025-03-26')

    const unknown = await rpc(harness, {
      jsonrpc: '2.0', id: 23, method: 'initialize',
      params: { protocolVersion: '1999-01-01' },
    })
    // 回退到服务端版本,而不是回显客户端的 '1999-01-01'。
    expect((unknown.json?.['result'] as { protocolVersion?: string }).protocolVersion).toBe('2025-03-26')
  })

  it('执行失败 → isError 内容;坏 key/坏 JSON 拒绝', async () => {
    harness = await makeHarness({ toolsExecuteError: true })
    const failed = await rpc(harness, {
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'bash', arguments: { command: 'x' } },
    })
    expect((failed.json?.['result'] as { isError?: boolean }).isError).toBe(true)

    const denied = await rpc(harness, { jsonrpc: '2.0', id: 6, method: 'tools/list' }, 'session=sess-ok&key=wrong')
    expect(denied.status).toBe(403)

    const badJson = await fetch(`${harness.baseUrl}?session=sess-ok&key=${harness.key}`, {
      method: 'POST', body: 'not-json',
    })
    expect(badJson.status).toBe(400)
  })

  it('--mcp-config 参数与配置文件:URL 带 session/key、工具直连(defer_loading:false);delegate/undefined 不生成', async () => {
    // 自建端点:不依赖前序用例残留的模块级 endpoint(此前该用例隐含依赖
    // 执行顺序,单独跑会因 endpoint===undefined 而失败)。
    harness = await makeHarness()
    const args = mcpConfigArgs('mcp', 'sess-x')
    expect(args[0]).toBe('--mcp-config')
    const server = (JSON.parse(readFileSync(args[1]!, 'utf8')) as {
      mcpServers: { dsh: { type: string; url: string; defer_loading?: boolean } }
    }).mcpServers.dsh
    // 全部工具直接展开(显式 false,防止被 CLI 全局 defer 开关覆盖成延迟加载)。
    expect(server.defer_loading).toBe(false)
    const url = new URL(server.url)
    expect(url.searchParams.get('session')).toBe('sess-x')
    expect((url.searchParams.get('key') ?? '').length).toBeGreaterThan(10)
    expect(mcpConfigArgs('delegate', 'sess-x')).toEqual([])
    // undefined 与 delegate 同义(低层缺省统一按 delegate,防混合态)。
    expect(mcpConfigArgs(undefined, 'sess-x')).toEqual([])
    expect(mcpConfigArgs('mcp', undefined)).toEqual([])
  })

  it('tools/call 优先转发进 loop(注册 dispatcher);转发失败回落直接执行', async () => {
    harness = await makeHarness()
    const calls: string[] = []
    const dispose = registerMcpLoopDispatcher('sess-ok', async (_sessionId, name, input) => {
      calls.push(`${name}:${JSON.stringify(input)}`)
      return { output: 'loop-executed', isError: false }
    })
    const forwarded = await rpc(harness, {
      jsonrpc: '2.0', id: 9, method: 'tools/call',
      params: { name: 'bash', arguments: { command: 'echo loop' } },
    })
    expect(forwarded.json?.['result']).toEqual({ content: [{ type: 'text', text: 'loop-executed' }] })
    expect(calls).toEqual(['bash:{"command":"echo loop"}'])
    // 走了 loop 转发就不落直接执行。
    expect(harness.executeCalls).toHaveLength(0)
    dispose()

    // 转发抛错(回合收尾竞态)→ 回落直接执行,调用不失败。
    const disposeThrow = registerMcpLoopDispatcher('sess-ok', async () => { throw new Error('pump gone') })
    const fallback = await rpc(harness, {
      jsonrpc: '2.0', id: 10, method: 'tools/call',
      params: { name: 'bash', arguments: { command: 'x' } },
    })
    expect(fallback.json?.['result']).toEqual({ content: [{ type: 'text', text: 'executed!' }] })
    disposeThrow()
  })

  it('dispatcher 报超时(注入可能已执行)→ 回 isError 且不回落重执', async () => {
    // 回归:超时后若降级直执,长命令会在 loop 侧与直执各跑一遍(副作用翻倍)。
    harness = await makeHarness()
    const disposeTimeout = registerMcpLoopDispatcher('sess-ok', async () => {
      throw new McpDispatchTimeoutError('MCP 调用 bash 等待 loop 执行超时(300s)')
    })
    const timedOut = await rpc(harness, {
      jsonrpc: '2.0', id: 11, method: 'tools/call',
      params: { name: 'bash', arguments: { command: 'npm run build' } },
    })
    const result = timedOut.json?.['result'] as { isError?: boolean; content?: { text?: string }[] }
    expect(result.isError).toBe(true)
    expect(result.content?.[0]?.text).toContain('未回落直执')
    // 关键断言:直接执行通道零调用(没有第二次执行)。
    expect(harness.executeCalls).toHaveLength(0)
    disposeTimeout()
  })

  it('sweepStaleMcpConfigs:只删超龄的 mcp- 文件,不动新文件与其他文件', () => {
    harness = undefined
    const dir = mkdtempSync(join(tmpdir(), 'dsh-mcp-sweep-'))
    try {
      const stale = join(dir, 'mcp-stale.json')
      const fresh = join(dir, 'mcp-fresh.json')
      const other = join(dir, 'keep.txt')
      writeFileSync(stale, '{}')
      writeFileSync(fresh, '{}')
      writeFileSync(other, '{}')
      const past = (Date.now() - 2 * 60 * 60 * 1000) / 1000
      utimesSync(stale, past, past)
      utimesSync(other, past, past)
      expect(sweepStaleMcpConfigs(dir, 60 * 60 * 1000)).toBe(1)
      expect(readdirSync(dir).sort()).toEqual(['keep.txt', 'mcp-fresh.json'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('MCP 转发看门狗取值约束(回归)', () => {
  it('看门狗是"注入未被消费"的宽松兜底,不得由尾注里未经验证的 30s 反推', () => {
    // 回归:2026-09-13 曾把看门狗设为 (30-5)=25s,依据只是尾注里那句"前台 MCP
    // 调用 30 秒超时"——但代码中并无 30s 常量(ACP 默认 60s/150s/600s),属未验证
    // 数字。25s 会把"本来能跑完的长前台命令"误判超时并回 isError。
    // 约束:①必须显著大于尾注口径,确保长命令不会被这一层截断;
    //       ②不得等于/小于尾注声明的预算。
    expect(MCP_CALL_TIMEOUT_MS).toBeGreaterThan(CLI_TOOL_CALL_TIMEOUT_S * 1_000)
    expect(MCP_CALL_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000)
  })
})
