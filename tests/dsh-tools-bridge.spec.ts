/**
 * dsh 工具通用桥的协议面测试:
 * - 列工具:schemas(agent) → `dsh_<原名>` 描述符(排除表/描述引导/inputSchema);
 * - 命名:bridgeToolId / bridgeTargetTool 的映射与排除;
 * - 执行:tools.execute 官方管线转发、内容块转文本、错误按协议回落;
 * - MCP 图片回传:blocksToMcpContent 的 text/image 转换与整体回退。
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  blocksToMcpContent,
  BRIDGE_TOOL_PREFIX,
  bridgeTargetTool,
  bridgeToolId,
  isBridgeEligible,
  listDshBridgeTools,
  runDshBridgeTool,
} from '../src/dsh-tools-bridge.ts'

/** 本机跑得动的 shell 工具名(与 preset 的 `disabled:` 门同规则)。 */
const NATIVE_SHELL = process.platform === 'win32' ? 'pwsh' : 'bash'
/** 本机跑不动的那个 shell 工具名。 */
const FOREIGN_SHELL = process.platform === 'win32' ? 'bash' : 'pwsh'

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
  it('dsh_<原名> 往返映射;完全统一后 shell/subagent 也走桥;run_code 与 MCP 不认', () => {
    expect(bridgeToolId('grep')).toBe('dsh_grep')
    expect(bridgeTargetTool('dsh_grep')).toBe('grep')
    // 完全统一:执行/委托类也走桥(指向 dsh 原生工具)。
    expect(bridgeTargetTool(`dsh_${NATIVE_SHELL}`)).toBe(NATIVE_SHELL)
    expect(bridgeTargetTool('dsh_subagent')).toBe('subagent')
    expect(bridgeTargetTool('dsh_send_message')).toBe('send_message')
    // 模型对 toolId 填写不稳定(实测会把展示名 Dsh-read / 变体 dsh-read 当
    // toolId 传):统一归一化受理,减少"unknown delegate tool"重试。
    expect(bridgeTargetTool('Dsh-read')).toBe('read')
    expect(bridgeTargetTool('dsh-read')).toBe('read')
    expect(bridgeTargetTool('read')).toBe('read')
    // 排除:ptc 保留名;MCP 走 CLI 原生通道;空 id;本机跑不动的平台工具。
    expect(bridgeTargetTool('dsh_run_code')).toBeUndefined()
    expect(bridgeTargetTool('dsh_mcp__codegraph__explore')).toBeUndefined()
    expect(bridgeTargetTool('')).toBeUndefined()
    expect(bridgeTargetTool(`dsh_${FOREIGN_SHELL}`)).toBeUndefined()
  })

  it('平台专用工具按平台剔除:win32 无 bash、非 win32 无 pwsh(与 preset 同规则)', () => {
    // 实测(2026-09-14):模型顺着 mcp__dsh__* 命名习惯调 mcp__dsh__bash,
    // CLI 对不存在的工具直接判 ModelBehaviorError 结束 run。preset 正常已把
    // 平台不对的 shell 挡在 agent scope 外,桥这层再按平台剔一次,保证下发给
    // CLI 的工具面只含本机跑得动的工具。
    const win = process.platform === 'win32'
    expect(isBridgeEligible('bash')).toBe(!win)
    expect(isBridgeEligible('pwsh')).toBe(win)
    // 规则只认这两个 shell 名,其它工具不受影响。
    expect(isBridgeEligible('read')).toBe(true)
    expect(isBridgeEligible('subagent')).toBe(true)
    // 工具面本身:两个 shell 都在 schemas 里时,只有本机那个下发。
    const { ctx } = makeBridgeCtx({
      schemas: [
        { name: 'bash', description: 'Run a command.', parameters: {} },
        { name: 'pwsh', description: 'Run a command.', parameters: {} },
        { name: 'read', description: 'Read a file.', parameters: {} },
      ],
    })
    const listed = listDshBridgeTools(ctx, { id: 'parent-1' } as never).map(tool => tool.id)
    expect(listed).toEqual([`dsh_${NATIVE_SHELL}`, 'dsh_read'])
  })
})

describe('listDshBridgeTools:注册描述符', () => {
  it('列出可见工具:前缀 id、唯一展示名、调用形态提示+身份标记+原描述', () => {
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
    // 调用形态提示放最前(截断保护),toolId 与参数名单从真实 schema 提取。
    expect(description).toContain('[call: toolId="dsh_read", input={path}]')
    expect(description).toContain('[dsh-side tool: "read"]')
    expect(description).toContain('Read a file.')
    // 工具说明保持 dsh 原文,不把桥接语义(优先用/执行位置)逐工具拼接——
    // 那些引导只属于 prompt 尾注(DSH_DELEGATION_NOTE)。
    expect(description).not.toContain('prefer this')
    expect(description).toBe('[call: toolId="dsh_read", input={path}] [dsh-side tool: "read"] Read a file.')
    expect(tools[0]!.inputSchema).toEqual({ type: 'object', properties: { path: { type: 'string' } } })
  })

  it('执行类照常桥接并附加后台引导;run_code 与 MCP 排除;缺 schema 用空对象', () => {
    const { ctx } = makeBridgeCtx({
      schemas: [
        { name: NATIVE_SHELL, description: 'Run a command.', parameters: {} },
        { name: 'run_code', description: 'x', parameters: {} },
        { name: 'mcp__server__tool', description: 'x', parameters: {} },
        { name: 'write', parameters: undefined },
      ],
    })
    const tools = listDshBridgeTools(ctx, { id: 'parent-1' } as never)
    expect(tools.map(tool => tool.id)).toEqual([`dsh_${NATIVE_SHELL}`, 'dsh_write'])
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

  it('read_image 桥接(CLI 内置工具全禁后,读图走 dsh 真工具)', () => {
    const { ctx } = makeBridgeCtx({
      schemas: [
        { name: 'read_image', description: 'Read an image.', parameters: { type: 'object', properties: {} } },
        { name: 'read', description: 'Read a file.', parameters: { type: 'object', properties: {} } },
      ],
    })
    const tools = listDshBridgeTools(ctx, { id: 'parent-1' } as never)
    expect(tools.map(tool => tool.id)).toEqual(['dsh_read_image', 'dsh_read'])
    expect(bridgeTargetTool('dsh_read_image')).toBe('read_image')
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
    expect(result.output).toBe('hello bridge')
    expect(result.isError).toBe(false)
    // 原始内容块随结果回传:MCP 端点据此回传图片(delegate 通道只读 output)。
    expect(result.content).toEqual([{ type: 'text', text: 'hello bridge' }])
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
    expect(result.isError).toBe(false)
    expect(result.output).toContain('head')
    expect(result.output).toContain('inner')
    expect(result.output).toContain('[image result')
    // 文本口径不变,但原始块(含 image)也一并回传(MCP 端点用)。
    expect(result.content).toHaveLength(3)
  })

  it('工具失败(isError)与 execute 抛错 → isError 回传(错误文本进 output)', async () => {
    const failed = makeBridgeCtx({
      execute: async () => ({ isError: true, content: [{ type: 'text', text: 'boom: not found' }] }),
    })
    const failedResult = await runDshBridgeTool(failed.ctx, { parentSessionId: 'parent-1', toolName: 'read', input: {} })
    expect(failedResult.isError).toBe(true)
    expect(failedResult.output).toContain('boom: not found')

    const throwing = makeBridgeCtx({ execute: async () => { throw new Error('pipeline crash') } })
    const thrownResult = await runDshBridgeTool(throwing.ctx, { parentSessionId: 'parent-1', toolName: 'read', input: {} })
    expect(thrownResult.isError).toBe(true)
    expect(thrownResult.output).toContain('pipeline crash')
  })

  it('parent 或 tools 缺失 → 明确错误,不执行', async () => {
    const noParent = makeBridgeCtx({ noParent: true })
    const missingParent = await runDshBridgeTool(noParent.ctx, { parentSessionId: 'parent-1', toolName: 'read', input: {} })
    expect(missingParent.isError).toBe(true)
    expect(missingParent.output).toContain('is not live')

    const noTools = makeBridgeCtx({ noTools: true })
    const missingTools = await runDshBridgeTool(noTools.ctx, { parentSessionId: 'parent-1', toolName: 'read', input: {} })
    expect(missingTools.isError).toBe(true)
    expect(missingTools.output).toContain('tools service is unavailable')
  })
})

describe('blocksToMcpContent:图片经 MCP content 回传', () => {
  /** 假 attachments 读图面:按 ref 里的字节返回。 */
  const face = (options?: { fail?: boolean }) => ({
    readImage: async (ref: unknown) => {
      if (options?.fail === true) throw new Error('attachment unreadable')
      return { data: Uint8Array.of(1, 2, 3), ref: { mediaType: (ref as { mediaType?: string }).mediaType ?? 'image/png' } }
    },
  })

  it('无图片/无服务面 → undefined(调用方沿用纯文本单块)', async () => {
    expect(await blocksToMcpContent(undefined, [{ type: 'text', text: 'x' }])).toBeUndefined()
    expect(await blocksToMcpContent(face(), [{ type: 'text', text: 'x' }])).toBeUndefined()
    expect(await blocksToMcpContent(face(), [])).toBeUndefined()
  })

  it('文本 + 图片 → text 与 image 块(base64 + mediaType)', async () => {
    const parts = await blocksToMcpContent(face(), [
      { type: 'text', text: 'head' },
      { type: 'image', attachment: { mediaType: 'image/png' } },
    ])
    expect(parts).toEqual([
      { type: 'text', text: 'head' },
      { type: 'image', data: Buffer.from([1, 2, 3]).toString('base64'), mimeType: 'image/png' },
    ])
  })

  it('嵌套 tool-result 里的图片同样展开', async () => {
    const parts = await blocksToMcpContent(face(), [
      { type: 'tool-result', content: [{ type: 'image', attachment: { mediaType: 'image/jpeg' } }] },
    ])
    expect(parts).toEqual([{ type: 'image', data: 'AQID', mimeType: 'image/jpeg' }])
  })

  it('有图但读不出 → undefined(整体回退,不半转换)', async () => {
    const parts = await blocksToMcpContent(face({ fail: true }), [
      { type: 'text', text: 'head' },
      { type: 'image', attachment: { mediaType: 'image/png' } },
    ])
    expect(parts).toBeUndefined()
  })
})
