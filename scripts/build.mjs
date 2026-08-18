#!/usr/bin/env node
/**
 * Build @dsh-external/dsh-subagent-codebuddy:
 *   tsc 编译服务端 src/*.ts → lib/*.js + lib/types/*.d.ts（ESM, bundler resolution）
 * 无 tsdown/react 构建依赖,Node 侧零运行时构建工具。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const pkg = join(root, '..')
const outDir = join(pkg, 'lib')

console.log('build: cleaning lib/')
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

console.log('build: tsc server half (src/*.ts → lib/)')
execFileSync('npx', ['tsc', '-p', join(pkg, 'tsconfig.json')], { stdio: 'inherit', shell: true })

console.log('build: done')
