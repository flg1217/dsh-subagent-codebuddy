/**
 * dsh→CodeBuddy 原生接入同步器的测试:
 * - MCP:profile 配置解析(mcp-client 行/引号/数组/跳过他项)、mcp.json 合并
 *   (保留用户条目、同名以 dsh 为准、内容不变不重写);
 * - Skill:目录联接接入、已存在跳过、幂等;
 * - 全部走临时目录,不触碰真实 home。
 */
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  parseMcpClientRows,
  syncMcpToCodebuddy,
  syncSkillsToCodebuddy,
} from '../src/cli-integrations.ts'

const temps: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-int-'))
  temps.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of temps.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ }
  }
})

/** 一份典型的 profile cordis.patch.yml 片段。 */
const PROFILE_YAML = `
# 用户 patch
    - id: mcp-codegraph
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: codegraph
        transport: stdio
        command: codegraph
        args: ['serve', '--mcp']

    - id: mcp-context7
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: context7
        transport: stdio
        command: npx
        args: ['-y', '@upstash/context7-mcp']

    - id: some-other-plugin
      name: '@deepseek-ai/dsh-something-else'
      config:
        serverName: not-mcp
        command: nope
`

describe('parseMcpClientRows:profile 配置解析', () => {
  it('只取 mcp-client 行块,读取 serverName/transport/command/args', () => {
    const rows = parseMcpClientRows(PROFILE_YAML)
    expect(rows.map(row => row.serverName)).toEqual(['codegraph', 'context7'])
    expect(rows[0]!.config['transport']).toBe('stdio')
    expect(rows[0]!.config['command']).toBe('codegraph')
    expect(rows[0]!.config['args']).toEqual(['serve', '--mcp'])
    expect(rows[1]!.config['args']).toEqual(['-y', '@upstash/context7-mcp'])
  })

  it('serverName 缺失或空文的行被丢弃', () => {
    const rows = parseMcpClientRows(`
    - id: mcp-broken
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: stdio
        command: x
`)
    expect(rows).toEqual([])
  })
})

describe('syncMcpToCodebuddy:合并写入 mcp.json', () => {
  it('dsh 的 server 合并进目标文件,保留用户已有条目,同名以 dsh 为准', () => {
    const root = tempDir()
    const profiles = join(root, 'profiles')
    mkdirSync(join(profiles, 'web'), { recursive: true })
    writeFileSync(join(profiles, 'web', 'cordis.patch.yml'), PROFILE_YAML)
    const target = join(root, 'codebuddy', 'mcp.json')
    mkdirSync(join(root, 'codebuddy'), { recursive: true })
    writeFileSync(target, JSON.stringify({
      mcpServers: {
        codegraph: { type: 'stdio', command: 'old-command', args: [] },
        mine: { type: 'stdio', command: 'keep-me' },
      },
    }))

    const result = syncMcpToCodebuddy(profiles, target)
    expect(result.servers).toEqual(['codegraph', 'context7'])
    const doc = JSON.parse(readFileSync(target, 'utf8')) as { mcpServers: Record<string, unknown> }
    // 同名被 dsh 侧覆盖。
    expect(doc.mcpServers['codegraph']).toEqual({ type: 'stdio', command: 'codegraph', args: ['serve', '--mcp'] })
    // 用户自己的条目保留。
    expect(doc.mcpServers['mine']).toEqual({ type: 'stdio', command: 'keep-me' })
    // 新 server 写入。
    expect(doc.mcpServers['context7']).toEqual({ type: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp'] })
  })

  it('无 mcp-client 配置时不动目标文件', () => {
    const root = tempDir()
    const profiles = join(root, 'profiles')
    mkdirSync(join(profiles, 'web'), { recursive: true })
    writeFileSync(join(profiles, 'web', 'cordis.yml'), '[]\n')
    const target = join(root, 'mcp.json')
    const result = syncMcpToCodebuddy(profiles, target)
    expect(result.servers).toEqual([])
    expect(() => readFileSync(target)).toThrow()
  })
})

describe('syncSkillsToCodebuddy:全部默认根接入', () => {
  it('用户根(dsh/agents)接入目标;含 SKILL.md 才接;幂等', () => {
    const home = tempDir()
    const target = tempDir()
    mkdirSync(join(home, 'dsh', 'skills', 'ponytail'), { recursive: true })
    writeFileSync(join(home, 'dsh', 'skills', 'ponytail', 'SKILL.md'), '---\nname: ponytail\n---\nbody\n')
    mkdirSync(join(home, 'dsh', 'skills', 'not-a-skill'), { recursive: true })
    mkdirSync(join(home, 'agents', 'skills', 'shared'), { recursive: true })
    writeFileSync(join(home, 'agents', 'skills', 'shared', 'SKILL.md'), 'from agents')

    const paths = {
      dshHome: join(home, 'dsh'),
      agentsHome: join(home, 'agents'),
      targetDir: target,
    }
    const first = syncSkillsToCodebuddy(paths)
    expect([...first.linked].sort()).toEqual(['ponytail', 'shared'])
    // 接入后从目标侧可读到内容(联接生效)。
    expect(readFileSync(join(target, 'ponytail', 'SKILL.md'), 'utf8')).toContain('name: ponytail')
    expect(readFileSync(join(target, 'shared', 'SKILL.md'), 'utf8')).toBe('from agents')
    // 无 SKILL.md 的目录不接入。
    expect(() => readlinkSync(join(target, 'not-a-skill'))).toThrow()

    // 幂等:第二次不再重复接入。
    expect(syncSkillsToCodebuddy(paths).linked).toEqual([])
  })

  it('项目根优先:同名时项目 skill 赢(user 根不覆盖)', () => {
    const home = tempDir()
    const target = tempDir()
    const project = join(home, 'proj')
    mkdirSync(join(project, '.git'), { recursive: true })
    mkdirSync(join(project, '.dsh', 'skills', 'ponytail'), { recursive: true })
    writeFileSync(join(project, '.dsh', 'skills', 'ponytail', 'SKILL.md'), 'from-project')
    mkdirSync(join(home, 'dsh', 'skills', 'ponytail'), { recursive: true })
    writeFileSync(join(home, 'dsh', 'skills', 'ponytail', 'SKILL.md'), 'from-user')

    const result = syncSkillsToCodebuddy({
      projectCwd: project,
      dshHome: join(home, 'dsh'),
      agentsHome: join(home, 'agents'),
      targetDir: target,
    })
    expect(result.linked).toEqual(['ponytail'])
    expect(readFileSync(join(target, 'ponytail', 'SKILL.md'), 'utf8')).toBe('from-project')
  })

  it('目标已存在同名目录(用户手放)时不覆盖', () => {
    const home = tempDir()
    const target = tempDir()
    mkdirSync(join(home, 'dsh', 'skills', 'ponytail'), { recursive: true })
    writeFileSync(join(home, 'dsh', 'skills', 'ponytail', 'SKILL.md'), 'from-dsh')
    mkdirSync(join(target, 'ponytail'), { recursive: true })
    writeFileSync(join(target, 'ponytail', 'SKILL.md'), 'user-owned')

    const result = syncSkillsToCodebuddy({ dshHome: join(home, 'dsh'), agentsHome: join(home, 'agents'), targetDir: target })
    expect(result.linked).toEqual([])
    expect(readFileSync(join(target, 'ponytail', 'SKILL.md'), 'utf8')).toBe('user-owned')
  })
})
