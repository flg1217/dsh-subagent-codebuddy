/**
 * MCP 转发看门狗取值约束(回归)。
 *
 * 从原 tests/mcp-server.spec.ts 拆出:该约束测的是本插件 pump 的常量
 * (端点本身在共享包 @flg1217/dsh-mcp,不含超时预算)。
 */
import { describe, expect, it } from 'vitest'
import { CLI_TOOL_CALL_TIMEOUT_S, MCP_CALL_TIMEOUT_MS } from '../src/pump.ts'

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
