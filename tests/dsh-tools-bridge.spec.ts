/**
 * dsh 工具通用桥的协议面测试:
 * - 列工具:schemas(agent) → `dsh_<原名>` 描述符(排除表/描述引导/inputSchema);
 * - 命名:bridgeToolId / bridgeTargetTool 的映射与排除;
 * - 执行:tools.execute 官方管线转发、内容块转文本、错误按协议回落。
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  BRIDGE_TOOL_PREFIX,
  bridgeTargetTool,
  bridgeToolId,
  listDshBridgeTools,
  runDshBridgeTool,
} from '../src/dsh-tools-bridge.ts'

/** 假 ctx:agents + tools 两个服务面。 */
function makeBridgeCtx(options?: {
  schemas?: Array<{ name: string; description?: string; parameters?: unknown }>
  schemasThrows?: boolean
  noTools?: boolean
  noParent?: boolean
  execute?: (exec: Record<string, unknown>) => Promise<unknown>
}): { ctx: Context; execCalls: Array<Record<string, unknown>> } {
  const execCalls: Array<Record<string, unknown>> = []
  const ctx = {
    get: (key: string) => {
      if (key === 'agents') {
        return { get: (id: string) => (options?.noParent === true ? undefined : { id }) }
      }
      if (key === 'tools') {
        if (options?.noTools === true) return undefined
        return {
          schemas: () => {
            if (options?.schemasThrows === true) throw new Error('schemas exploded')
            return options?.schemas ?? []
          },
          execute: async (exec: Record<string, unknown>) => {
            execCalls.push(exec)
            return options?.execute === undefined
              ? { isError: false, content: [{ type: 'text', text: 'done' }] }
              : await options.execute(exec)
          },
        }
      }
      return undefined
    },
  } as unknown as Context
  return { ctx, execCalls }
}

describe('bridgeToolId / bridgeTargetTool:命名与排除', () => {
  it('dsh_<原名> 往返映射;完全统一后 bash/subagent 也走桥;run_code 与 MCP 不认', () => {
    expect(bridgeToolId('grep')).toBe('dsh_grep')
    expect(bridgeTargetTool('dsh_grep')).toBe('grep')
    // 完全统一:执行/委托类也走桥(指向 dsh 原生工具)。
    expect(bridgeTargetTool('dsh_bash')).toBe('bash')
    expect(bridgeTargetTool('dsh_pwsh')).toBe('pwsh')
    expect(bridgeTargetTool('dsh_subagent')).toBe('subagent')
    expect(bridgeTargetTool('dsh_send_message')).toBe('send_message')
    // 排除:ptc 保留名;MCP 走 CLI 原生通道。
    expect(bridgeTargetTool('dsh_run_code')).toBeUndefined()
    expect(bridgeTargetTool('dsh_mcp__codegraph__explore')).toBeUndefined()
    expect(bridgeTargetTool('read')).toBeUndefined()
    expect(bridgeTargetTool(BRIDGE_TOOL_PREFIX)).toBeUndefined()
  })
})

describe('listDshBridgeTools:注册描述符', () => {
  it('列出可见工具:前缀 id、唯一展示名、描述带 dsh 侧语义与"优先用"引导', () => {
    const { ctx } = makeBridgeCtx({
      schemas: [
        { name: 'read', description: 'Read a file.', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
        { name: 'grep', description: 'Search.', parameters: { type: 'object', properties: {} } },
      ],
    })
    const tools = listDshBridgeTools(ctx, { id: 'parent-1' } as never)
    expect(tools.map(tool => tool.id)).toEqual(['dsh_read', 'dsh_grep'])
    expect(tools[0]!.name).toBe('Dsh-read')
    const description = tools[0]!.description
    expect(description).toContain('[dsh-side tool: "read"]')
    expect(description).toContain('Read a file.')
    expect(description).toContain('prefer this dsh-side tool')
    expect(tools[0]!.inputSchema).toEqual({ type: 'object', properties: { path: { type: 'string' } } })
  })

  it('执行类照常桥接并附加后台引导;run_code 与 MCP 排除;缺 schema 用空对象', () => {
    const { ctx } = makeBridgeCtx({
      schemas: [
        { name: 'bash', description: 'Run a command.', parameters: {} },
        { name: 'run_code', description: 'x', parameters: {} },
        { name: 'mcp__server__tool', description: 'x', parameters: {} },
        { name: 'write', parameters: undefined },
      ],
    })
    const tools = listDshBridgeTools(ctx, { id: 'parent-1' } as never)
    expect(tools.map(tool => tool.id)).toEqual(['dsh_bash', 'dsh_write'])
    // 执行类附加 run_in_background 强引导;job 语义(面板/通知)写明。
    expect(tools[0]!.description).toContain('run_in_background: true')
    expect(tools[0]!.description).toContain('background-jobs view')
    // 非执行类不带执行引导;缺 parameters 时给合法空 schema。
    expect(tools[1]!.description).toContain('[dsh-side tool: "write"]')
    expect(tools[1]!.description).not.toContain('run_in_background')
    expect(tools[1]!.inputSchema).toEqual({ type: 'object', properties: {} })
  })

  it('会话内 CLI 镜像代理(cli_*)既不出现在桥列表、也不受理桥调用', () => {
    const { ctx } = makeBridgeCtx({
      schemas: [
        { name: 'read', description: 'Read a file.', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
        // 镜像代理长这样:名字 cli_<CLI 原生工具名>,参数为空,描述说明它只是回放。
        { name: 'cli_read', description: '"read" was executed by the CodeBuddy CLI on this session.', parameters: {} },
      ],
    })
    const tools = listDshBridgeTools(ctx, { id: 'parent-1' } as never)
    // 真 read 照旧桥接;镜像不出现(否则模型会看到一个空 schema 的假 read)。
    expect(tools.map(tool => tool.id)).toEqual(['dsh_read'])
    // 即便模型手滑拼出 dsh_cli_*,也不解析成工具调用。
    expect(bridgeTargetTool('dsh_cli_read')).toBeUndefined()
    expect(bridgeTargetTool('dsh_read')).toBe('read')
  })

  it('schemas 抛错或 tools 服务缺失 → 空列表(桥不拖垮注册)', () => {
    const throwing = makeBridgeCtx({ schemasThrows: true })
    expect(listDshBridgeTools(throwing.ctx, { id: 'p' } as never)).toEqual([])
    const missing = makeBridgeCtx({ noTools: true })
    expect(listDshBridgeTools(missing.ctx, { id: 'p' } as never)).toEqual([])
  })
})

describe('runDshBridgeTool:执行转发', () => {
  it('走 tools.execute 官方管线:参数/归属/信号透传,文本结果原样回灌', async () => {
    const { ctx, execCalls } = makeBridgeCtx({
      execute: async () => ({ isError: false, content: [{ type: 'text', text: 'hello bridge' }] }),
    })
    const signal = new AbortController().signal
    const result = await runDshBridgeTool(ctx, {
      parentSessionId: 'parent-1',
      toolName: 'grep',
      input: { pattern: 'x' },
      signal,
    })
    expect(result).toEqual({ status: 'success', output: 'hello bridge' })
    expect(execCalls).toHaveLength(1)
    expect(execCalls[0]!['name']).toBe('grep')
    expect(execCalls[0]!['arguments']).toEqual({ pattern: 'x' })
    expect(execCalls[0]!['agent']).toEqual({ id: 'parent-1' })
    expect(execCalls[0]!['signal']).toBe(signal)
    expect(typeof execCalls[0]!['callId']).toBe('string')
  })

  it('内容块转文本:嵌套 tool-result 递归,图片块降级为提示', async () => {
    const { ctx } = makeBridgeCtx({
      execute: async () => ({
        isError: false,
        content: [
          { type: 'text', text: 'head' },
          { type: 'tool-result', content: [{ type: 'text', text: 'inner' }] },
          { type: 'image', attachment: { id: 'a' } },
        ],
      }),
    })
    const result = await runDshBridgeTool(ctx, { parentSessionId: 'parent-1', toolName: 'read_image', input: {} })
    expect(result.status).toBe('success')
    if (result.status === 'success') {
      expect(result.output).toContain('head')
      expect(result.output).toContain('inner')
      expect(result.output).toContain('[image result')
    }
  })

  it('工具失败(isError)与 execute 抛错 → 按协议回 status:error', async () => {
    const failed = makeBridgeCtx({
      execute: async () => ({ isError: true, content: [{ type: 'text', text: 'boom: not found' }] }),
    })
    const failedResult = await runDshBridgeTool(failed.ctx, { parentSessionId: 'parent-1', toolName: 'read', input: {} })
    expect(failedResult.status).toBe('error')
    if (failedResult.status === 'error') expect(failedResult.error.message).toContain('boom: not found')

    const throwing = makeBridgeCtx({ execute: async () => { throw new Error('pipeline crash') } })
    const thrownResult = await runDshBridgeTool(throwing.ctx, { parentSessionId: 'parent-1', toolName: 'read', input: {} })
    expect(thrownResult.status).toBe('error')
    if (thrownResult.status === 'error') expect(thrownResult.error.message).toContain('pipeline crash')
  })

  it('parent 或 tools 缺失 → 明确错误,不执行', async () => {
    const noParent = makeBridgeCtx({ noParent: true })
    const missingParent = await runDshBridgeTool(noParent.ctx, { parentSessionId: 'parent-1', toolName: 'read', input: {} })
    expect(missingParent.status).toBe('error')
    if (missingParent.status === 'error') expect(missingParent.error.message).toContain('is not live')

    const noTools = makeBridgeCtx({ noTools: true })
    const missingTools = await runDshBridgeTool(noTools.ctx, { parentSessionId: 'parent-1', toolName: 'read', input: {} })
    expect(missingTools.status).toBe('error')
    if (missingTools.status === 'error') expect(missingTools.error.message).toContain('tools service is unavailable')
  })
})
