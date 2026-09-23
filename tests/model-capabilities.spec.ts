/**
 * 模型能力解析测试:纯解析(parseModelsJson / lookupSupportsImages)、路径解析
 * (CODEBUDDY_CONFIG_DIR)、索引缓存(mtime 失效 / 去抖 / 失败缓存 / invalidate)。
 * 全部走临时目录 fixture,不读真实 `~/.codebuddy`。
 */
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CUSTOM_LOCAL_PREFIX,
  CUSTOM_PREFIX,
  createModelCapabilityIndex,
  lookupSupportsImages,
  parseModelsJson,
  resolveCodebuddyConfigDir,
  resolveCodebuddyModelsPath,
} from '../src/model-capabilities.ts'

const tempDirs: string[] = []

/** 建一个临时配置目录,返回其中的 models.json 路径。 */
function tempModelsPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cb-caps-'))
  tempDirs.push(dir)
  return join(dir, 'models.json')
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  delete process.env.CODEBUDDY_CONFIG_DIR
})

describe('parseModelsJson', () => {
  it('解析 models[] 的 id → supportsImages', () => {
    const table = parseModelsJson(JSON.stringify({
      models: [
        { id: 'deepseek-v4.1-flash', supportsImages: true },
        { id: 'deepseek-v4-flash', supportsImages: false },
      ],
    }))
    expect(table.get('deepseek-v4.1-flash')).toBe(true)
    expect(table.get('deepseek-v4-flash')).toBe(false)
  })

  it('条目缺 supportsImages / 非 boolean → 按不支持(登记但非多模态)', () => {
    const table = parseModelsJson(JSON.stringify({
      models: [
        { id: 'no-field' },
        { id: 'string-true', supportsImages: 'true' },
      ],
    }))
    expect(table.get('no-field')).toBe(false)
    expect(table.get('string-true')).toBe(false)
  })

  it('非法 JSON / models 非数组 / 条目缺 id → 空表或跳过(不抛错)', () => {
    expect(parseModelsJson('not json').size).toBe(0)
    expect(parseModelsJson(JSON.stringify({ models: {} })).size).toBe(0)
    const table = parseModelsJson(JSON.stringify({
      models: [{ supportsImages: true }, null, 'x', { id: '  ', supportsImages: true }, { id: 'ok', supportsImages: true }],
    }))
    expect([...table.keys()]).toEqual(['ok'])
  })
})

describe('lookupSupportsImages', () => {
  const table = new Map<string, boolean>([
    ['deepseek-v4.1-flash', true],
    ['deepseek-v4-flash', false],
  ])

  it('原样命中', () => {
    expect(lookupSupportsImages(table, 'deepseek-v4.1-flash')).toEqual({ supportsImages: true, known: true })
    expect(lookupSupportsImages(table, 'deepseek-v4-flash')).toEqual({ supportsImages: false, known: true })
  })

  it('剥别名前缀回查(custom-local: / custom:)', () => {
    expect(lookupSupportsImages(table, `${CUSTOM_LOCAL_PREFIX}deepseek-v4.1-flash`))
      .toEqual({ supportsImages: true, known: true })
    expect(lookupSupportsImages(table, `${CUSTOM_PREFIX}deepseek-v4-flash`))
      .toEqual({ supportsImages: false, known: true })
  })

  it('未登记 → known=false 且按仅文本', () => {
    expect(lookupSupportsImages(table, 'glm-5.3')).toEqual({ supportsImages: false, known: false })
    expect(lookupSupportsImages(table, '')).toEqual({ supportsImages: false, known: false })
  })
})

describe('路径解析', () => {
  it('CODEBUDDY_CONFIG_DIR 覆写配置目录(与 CLI 口径一致)', () => {
    process.env.CODEBUDDY_CONFIG_DIR = 'D:/tmp/cb-config'
    expect(resolveCodebuddyConfigDir()).toBe('D:/tmp/cb-config')
    expect(resolveCodebuddyModelsPath()).toBe(join('D:/tmp/cb-config', 'models.json'))
  })

  it('无环境变量时回退 ~/.codebuddy;显式目录优先', () => {
    expect(resolveCodebuddyConfigDir()).toBe(join(homedir(), '.codebuddy'))
    expect(resolveCodebuddyModelsPath('D:/x')).toBe(join('D:/x', 'models.json'))
    expect(resolveCodebuddyModelsPath('  ')).toBe(join(homedir(), '.codebuddy', 'models.json'))
  })
})

describe('createModelCapabilityIndex', () => {
  it('命中 true/false;未登记按仅文本且 known=false', () => {
    const path = tempModelsPath()
    writeFileSync(path, JSON.stringify({
      models: [{ id: 'multi', supportsImages: true }, { id: 'text-only', supportsImages: false }],
    }))
    const index = createModelCapabilityIndex({ modelsPath: () => path })
    expect(index.capabilityOf('multi')).toEqual({ supportsImages: true, known: true })
    expect(index.capabilityOf('text-only')).toEqual({ supportsImages: false, known: true })
    expect(index.capabilityOf('glm-5.3')).toEqual({ supportsImages: false, known: false })
    expect(index.path()).toBe(path)
  })

  it('文件缺失 / 内容损坏 → 全按仅文本,不抛错', () => {
    const missing = createModelCapabilityIndex({ modelsPath: () => tempModelsPath() })
    expect(missing.capabilityOf('multi')).toEqual({ supportsImages: false, known: false })

    const path = tempModelsPath()
    writeFileSync(path, '{ broken')
    const broken = createModelCapabilityIndex({ modelsPath: () => path })
    expect(broken.capabilityOf('multi')).toEqual({ supportsImages: false, known: false })
  })

  it('mtime/size 变化在去抖窗口后立刻生效(不必等 TTL)', () => {
    let clock = 1_000_000
    const path = tempModelsPath()
    writeFileSync(path, JSON.stringify({ models: [{ id: 'multi', supportsImages: true }] }))
    const index = createModelCapabilityIndex({ modelsPath: () => path, now: () => clock })
    expect(index.capabilityOf('multi').supportsImages).toBe(true)

    // 去抖窗口内:即使文件已变也沿用缓存(避免高频 stat)。
    writeFileSync(path, JSON.stringify({ models: [{ id: 'multi', supportsImages: false }] }))
    clock += 500
    expect(index.capabilityOf('multi').supportsImages).toBe(true)

    // 越过去抖窗口:文件身份变化 → 立即重读。
    clock += 600
    expect(index.capabilityOf('multi').supportsImages).toBe(false)
  })

  it('失败缓存 60s:期间新出现的文件不重读,过期后读到', () => {
    let clock = 5_000_000
    const path = tempModelsPath()
    const index = createModelCapabilityIndex({ modelsPath: () => path, now: () => clock })
    expect(index.capabilityOf('multi').known).toBe(false)

    writeFileSync(path, JSON.stringify({ models: [{ id: 'multi', supportsImages: true }] }))
    clock += 30_000
    expect(index.capabilityOf('multi').known).toBe(false)

    clock += 31_000
    expect(index.capabilityOf('multi')).toEqual({ supportsImages: true, known: true })
  })

  it('invalidate() 丢弃缓存,下一次调用重读', () => {
    let clock = 9_000_000
    const path = tempModelsPath()
    writeFileSync(path, JSON.stringify({ models: [{ id: 'multi', supportsImages: true }] }))
    const index = createModelCapabilityIndex({ modelsPath: () => path, now: () => clock })
    expect(index.capabilityOf('multi').supportsImages).toBe(true)

    writeFileSync(path, JSON.stringify({ models: [{ id: 'multi', supportsImages: false }] }))
    clock += 10
    index.invalidate()
    expect(index.capabilityOf('multi').supportsImages).toBe(false)
  })

  it('mtime 与 size 都不变时,超过 30s 强制重读', () => {
    let clock = 20_000_000
    const path = tempModelsPath()
    const stamp = new Date(1_000_000_000_000)
    const first = JSON.stringify({ models: [{ id: 'aaa', supportsImages: false }] })
    writeFileSync(path, first)
    utimesSync(path, stamp, stamp)
    const index = createModelCapabilityIndex({ modelsPath: () => path, now: () => clock })
    expect(index.capabilityOf('aaa').supportsImages).toBe(false)

    // 同长度内容 + 回填 mtime:只有强制重读上限能发现这次变化。
    const second = `${JSON.stringify({ models: [{ id: 'aaa', supportsImages: true }] })} `
    expect(second.length).toBe(first.length)
    writeFileSync(path, second)
    utimesSync(path, stamp, stamp)

    clock += 10_000
    expect(index.capabilityOf('aaa').supportsImages).toBe(false)
    clock += 21_000
    expect(index.capabilityOf('aaa').supportsImages).toBe(true)
  })
})
