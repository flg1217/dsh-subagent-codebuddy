/**
 * MCP 转发看门狗取值约束(回归)。
 *
 * 从原 tests/mcp-server.spec.ts 拆出:该约束测的是本插件 pump 的常量
 * (端点本身在共享包 @flg1217/dsh-mcp,不含超时预算)。
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  CLI_TOOL_CALL_TIMEOUT_S,
  LATE_MCP_RESULT_TTL_MS,
  MCP_CALL_TIMEOUT_MS,
  watchLateMcpResult,
} from '../src/pump.ts'

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

/** 最小事件面 ctx:捕获 session/event 处理器。 */
function makeWatchCtx(): { ctx: Context; emit: (session: unknown, event: unknown) => void } {
  let handler: ((...args: unknown[]) => void) | undefined
  const ctx = {
    on: (name: string, h: (...args: unknown[]) => void) => {
      if (name === 'session/event') handler = h
      return () => { /* 不注销 */ }
    },
  } as unknown as Context
  return { ctx, emit: (session, event) => { handler?.(session, event) } }
}

const SESSION = { header: { id: 'sess-late' } }

/** 构造一条 tool/result 事件(callId 同时放在 block 与 source 上)。 */
function toolResult(callId: string, text: string): unknown {
  return {
    type: 'tool/result',
    data: {
      message: {
        source: { callId },
        content: [{ toolCallId: callId, content: [{ type: 'text', text }] }],
      },
    },
  }
}

describe('迟到结果订阅(泵释放后的补投通道)', () => {
  it('TTL 必须覆盖真人作答时长(10 分钟曾丢过 61 分钟后到达的提问答案)', () => {
    // 事故(2026-09-20):ask_user_question 转发 1800s 超时 → 泵释放转本订阅 →
    // 用户 61 分钟后作答;旧 TTL 10 分钟订阅已自毁,答案只落到 dsh 会话、
    // 从未到达 CLI 模型。TTL 至少数小时,给"人离开一会儿再回答"留足窗口。
    expect(LATE_MCP_RESULT_TTL_MS).toBeGreaterThanOrEqual(6 * 60 * 60_000)
  })

  it('命中 callId:补投一次且订阅随即失效(不重复投递)', () => {
    const { ctx, emit } = makeWatchCtx()
    const calls: Array<[string, string]> = []
    watchLateMcpResult(ctx, 'sess-late', 'mcp-1', 'ask_user_question', (n, t) => calls.push([n, t]))
    emit(SESSION, toolResult('mcp-1', '答案正文'))
    expect(calls).toEqual([['ask_user_question', '答案正文']])
    emit(SESSION, toolResult('mcp-1', '答案正文'))
    expect(calls).toHaveLength(1)
  })

  it('其它 callId / 其它会话的事件不触发', () => {
    const { ctx, emit } = makeWatchCtx()
    const calls: unknown[] = []
    watchLateMcpResult(ctx, 'sess-late', 'mcp-1', 'ask_user_question', (...a) => calls.push(a))
    emit(SESSION, toolResult('mcp-2', 'x'))
    emit({ header: { id: 'sess-other' } }, toolResult('mcp-1', 'x'))
    expect(calls).toHaveLength(0)
  })

  it('超过 TTL 的迟到结果不再补投(订阅已自毁)', async () => {
    const { ctx, emit } = makeWatchCtx()
    const calls: unknown[] = []
    watchLateMcpResult(ctx, 'sess-late', 'mcp-1', 'ask_user_question', (...a) => calls.push(a), 10)
    await new Promise(resolve => setTimeout(resolve, 40))
    emit(SESSION, toolResult('mcp-1', '太晚的答案'))
    expect(calls).toHaveLength(0)
  })
})
