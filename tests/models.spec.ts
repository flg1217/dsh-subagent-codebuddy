/**
 * 模型目录测试:parseCodebuddyModelIds 纯解析;adapter.listModels 缓存/并发合并/
 * CLI 失败回退且永不抛错。
 */
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { listCodebuddyModelIdsAsync, parseCodebuddyModelIds } from '../src/models.ts'
import { CodebuddyLlmAdapter } from '../src/adapter.ts'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn(), spawnSync: vi.fn() }
})
const { spawn } = await import('node:child_process')
const mockedSpawn = vi.mocked(spawn)

const HELP_TEXT = 'Usage: codebuddy [options]\n  --model <id>  Model to use. Currently supported: (glm-5.3, deepseek-v4-flash, kimi-k3)\n'

function fakeHelpProcess(text: string | undefined, ok = true): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void } {
  const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void }
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.kill = (): void => {}
  setTimeout(() => {
    if (!ok) {
      proc.emit('error', new Error('spawn codebuddy ENOENT'))
      return
    }
    proc.stdout.emit('data', text ?? '')
    proc.emit('close', 0)
  }, 5)
  return proc
}

function makeAdapter(modelOf = () => 'glm-5.3'): CodebuddyLlmAdapter {
  const ctx = { get: () => undefined } as unknown as Context
  return new CodebuddyLlmAdapter(ctx, {
    command: 'codebuddy.js',
    prefixArgs: [],
    modelOf,
    permissionMode: 'bypassPermissions',
    extraArgs: [],
  })
}

beforeEach(() => {
  mockedSpawn.mockReset()
})

describe('parseCodebuddyModelIds', () => {
  it('解析 "Currently supported: (...)" 列表并去空白', () => {
    expect(parseCodebuddyModelIds(HELP_TEXT)).toEqual(['glm-5.3', 'deepseek-v4-flash', 'kimi-k3'])
  })

  it('无匹配返回空数组', () => {
    expect(parseCodebuddyModelIds('no models here')).toEqual([])
  })
})

describe('listCodebuddyModelIdsAsync', () => {
  it('异步读取 help 输出并解析', async () => {
    mockedSpawn.mockImplementation(() => fakeHelpProcess(HELP_TEXT) as never)
    const ids = await listCodebuddyModelIdsAsync('codebuddy.js', [])
    expect(ids).toEqual(['glm-5.3', 'deepseek-v4-flash', 'kimi-k3'])
  })

  it('进程错误时返回空数组(不抛错)', async () => {
    mockedSpawn.mockImplementation(() => fakeHelpProcess(undefined, false) as never)
    await expect(listCodebuddyModelIdsAsync('codebuddy.js', [])).resolves.toEqual([])
  })
})

describe('adapter.resolveModel', () => {
  it('暴露推理强度档位(low..ultracode),不设默认(保持 CLI 默认)', async () => {
    const adapter = makeAdapter()
    const info = await adapter.resolveModel('codebuddy', 'glm-5.3')
    expect(info.reasoning?.efforts.map(effort => effort.id)).toEqual([
      'low', 'medium', 'high', 'xhigh', 'max', 'ultracode',
    ])
    expect(info.reasoning?.defaultEffort).toBeUndefined()
    expect(info.inputModalities).toEqual(['text', 'image'])
  })
})

describe('adapter.listModels', () => {
  it('目录 = CLI ids ∪ 配置默认模型', async () => {
    mockedSpawn.mockImplementation(() => fakeHelpProcess(HELP_TEXT) as never)
    const adapter = makeAdapter(() => 'custom-model')
    const models = await adapter.listModels('codebuddy')
    expect(models.map(m => m.id)).toEqual(['glm-5.3', 'deepseek-v4-flash', 'kimi-k3', 'custom-model'])
    expect(models.every(m => m.provider === 'codebuddy')).toBe(true)
  })

  it('成功结果带 TTL 缓存:第二次调用不重新 spawn', async () => {
    mockedSpawn.mockImplementation(() => fakeHelpProcess(HELP_TEXT) as never)
    const adapter = makeAdapter()
    await adapter.listModels('codebuddy')
    await adapter.listModels('codebuddy')
    expect(mockedSpawn).toHaveBeenCalledTimes(1)
  })

  it('并发调用合并为一次 spawn', async () => {
    mockedSpawn.mockImplementation(() => fakeHelpProcess(HELP_TEXT) as never)
    const adapter = makeAdapter()
    const [a, b] = await Promise.all([adapter.listModels('codebuddy'), adapter.listModels('codebuddy')])
    expect(a).toEqual(b)
    expect(mockedSpawn).toHaveBeenCalledTimes(1)
  })

  it('CLI 失败 → 回退配置模型,永不抛错', async () => {
    mockedSpawn.mockImplementation(() => fakeHelpProcess(undefined, false) as never)
    const adapter = makeAdapter(() => 'custom-model')
    const models = await adapter.listModels('codebuddy')
    expect(models.map(m => m.id)).toEqual(['custom-model'])
  })

  it('CLI 失败且无配置模型 → 空目录,也抛错', async () => {
    mockedSpawn.mockImplementation(() => fakeHelpProcess(undefined, false) as never)
    const adapter = makeAdapter(() => '')
    await expect(adapter.listModels('codebuddy')).resolves.toEqual([])
  })
})
