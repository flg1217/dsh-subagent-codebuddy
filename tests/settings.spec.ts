/**
 * 设置解析回归(0.2.1 volatile 模型):bridgeMode 等字段的取值由 Config schema
 * 解析(profile 条目 config 作 base 层、表单写入覆盖)+ 插件 apply 的 filled()
 * 空串兜底组成。
 *
 * 旧回归背景:0.1.3 的 OR 合成会让配置 delegate 一票否决表单里的 mcp——现在
 * 插件不再手工合成两层,该 bug 类在结构上不可能再出现;此文件锁定 schema
 * 默认值与显式值的解析行为,以及空串回退默认(防 spawn ENOENT)。
 */
import { describe, expect, it } from 'vitest'
import { Config } from '../src/index.ts'

describe('settings:Config schema 解析', () => {
  it('显式值覆盖默认:bridgeMode 两个方向都生效', () => {
    expect(Config({ bridgeMode: 'delegate' }).bridgeMode.get()).toBe('delegate')
    expect(Config({ bridgeMode: 'mcp' }).bridgeMode.get()).toBe('mcp')
  })

  it('缺省 → schema 默认(mcp / codebuddy / deepseek-v4-flash / 自动放行)', () => {
    const config = Config({})
    expect(config.bridgeMode.get()).toBe('mcp')
    expect(config.command.get()).toBe('codebuddy')
    expect(config.model.get()).toBe('deepseek-v4-flash')
    expect(config.permissionMode.get()).toBe('bypassPermissions')
    expect(config.registerSubagentTools.get()).toBe(false)
  })

  it('空串是显式输入:apply 的 filled() 视为未配置回退默认(此处只锁 schema 保留空串)', () => {
    expect(Config({ command: '' }).command.get()).toBe('')
  })
})
