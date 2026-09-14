import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 隔离 --mcp-config 落盘目录:默认目录属于正在运行的 dsh 服务,测试不得
    // 写入或清扫它(见 tests/setup-isolate-mcp-dir.ts 的说明)。
    setupFiles: ['./tests/setup-isolate-mcp-dir.ts'],
  },
})
