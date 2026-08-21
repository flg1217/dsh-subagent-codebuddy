# dsh-subagent-codebuddy

> **CodeBuddy Code CLI 子代理插件 — DeepSeek Harness (dsh) 的独立推理子代理提供方**
> 把腾讯 CodeBuddy CLI 接入 dsh：每个子代理是 dsh 进程内的独立会话（可并行、可续聊），每次 LLM 调用经适配器 spawn CodeBuddy 执行。完全遵循 dsh 官方扩展机制，零源码改动。

## 一、这是什么

**dsh-subagent-codebuddy** 以 LLM 适配器架构（对齐 dsh-llm-agy）把 CodeBuddy 注册为 dsh 子代理提供方：

| 能力 | 说明 |
| --- | --- |
| **独立推理子代理** | 注册 `codebuddy` provider 路由与 `subagent_codebuddy` 委派工具 |
| **进程内会话管理** | 每个子代理是 dsh 内 child agent——可并行创建、`send_message` 续聊，互不干扰 |
| **上下文由 dsh 管理** | 每次调用把该子代理的完整历史序列化进 prompt，不依赖 CodeBuddy 存储 |
| **工具步骤回传** | 文本与工具步骤（`tool/call` + `tool/result`）在 dsh 会话与 CodeBuddy 进程间双向翻译 |

**与"ACP 直接子代理"方案的区别**：子代理是 dsh 进程内 agent，上下文连续性由 dsh 会话管理，不存在 CodeBuddy 按 cwd 自动续上下文造成的跨任务串味（实测 `codebuddy --acp` 按工作目录自动续上一会话、参数无法隔离，故本插件不走 ACP）。

## 二、核心功能

### 1. 子代理提供方（provider 路由 `codebuddy`）

`subagent_codebuddy` 工具 → dsh 子代理 → `CodebuddyLlmAdapter` → `codebuddy -p --output-format stream-json`。CodeBuddy 拥有自己的系统提示词、工具面、模型与权限执行；dsh 负责子代理生命周期与上下文。

### 2. 图片输入（粘贴/引用 → 本地路径）

用户消息里的图片块由序列化层落盘为临时文件，prompt 中给出本地路径，CodeBuddy 自行读取看图。

### 3. 长上下文保护（Windows 命令行 32K 限制）

prompt 超过阈值（26K 字符）自动写入临时任务文件，命令行只给短引用，CodeBuddy 完整读取任务描述。

## 三、快速开始

### 系统要求

- dsh `>= 0.1.0-rc.6`(兼容性验证日期:2026-08-21,验证于 dsh rc.8)
- CodeBuddy CLI 已安装并登录(子进程继承登录态)

### 安装插件

方式一（推荐，`lib/` 已随仓库提交，免构建）：

```bash
node scripts/link-profile.mjs            # 默认装配进 web profile
# 或等价于:dsh plugin --profile web add <本仓库目录>
```

方式二（发布仓库安装）：

```bash
dsh plugin --profile web add https://github.com/flg1217/dsh-subagent-codebuddy
```

无论哪种方式，安装后都要在 profile 的 `cordis.patch.yml` 加入插件行：

```yaml
- insert:
    - id: subagent-codebuddy
      name: '@flg1217/dsh-subagent-codebuddy'
      config:
        command: codebuddy
        model: deepseek-v4-flash
        permissionMode: bypassPermissions
        providerName: codebuddy
        toolName: subagent_codebuddy
```

完成后重启 dsh web，重开会话，工具列表出现 `subagent_codebuddy` 与 `list_codebuddy_models`。

### 卸载插件

```bash
dsh plugin --profile web remove @flg1217/dsh-subagent-codebuddy
```

如残留，手工清理：移除 profile（`~/.dsh/profiles/web`）的 `cordis.patch.yml` 中
`subagent-codebuddy` 的 `- insert` 块，以及 `package.json` dependencies 中对应的
`@flg1217/dsh-subagent-codebuddy` 行。卸载后重启 dsh web 即完全移除
（CodeBuddy CLI 本身不受影响）。

### 动态模型选择

- `subagent_codebuddy` 接受可选参数 `model`：主代理可传入模型 id 覆盖插件默认模型（不传则用配置的 `model`）。
- `list_codebuddy_models` 从 `codebuddy --help` 实时解析当前支持的模型 id 列表，主代理可先查询再传入准确 id。

### 配置项

| 键 | 默认 | 含义 |
|---|---|---|
| `command` | `codebuddy` | 可执行文件（Windows 自动解析 npm cmd-shim → `node <真实CLI>`） |
| `model` | `deepseek-v4-flash` | CodeBuddy 模型 ID（`--model <id>`） |
| `permissionMode` | `bypassPermissions` | `--permission-mode`：子代理工具调用自动放行 |
| `extraArgs` | `[]` | 追加的 CodeBuddy 参数 |
| `providerName` | `codebuddy` | LLM provider 路由名 |
| `toolName` | `subagent_codebuddy` | 模型可见工具名 |
| `registerSubagentTools` | `true` | 是否注册委派工具 |

## 四、典型用法

- **委派设计任务**：主代理把前端/UI 任务委派给 `subagent_codebuddy`（continuable，可复用作图长线会话），可用 `model` 参数动态指定模型。
- **并行调研**：拆分独立任务到多个 CodeBuddy 子代理并行执行，结果互不干扰。
- **模型选择**：委派前先调 `list_codebuddy_models` 查询当前支持的模型 id，再以 `model` 参数传入。
- **保守权限**：默认 `bypassPermissions` 全自动；如要更保守，改 `acceptEdits` 或 `plan`。

## 五、工作原理

```
tool-subagent(provider: spawn, backgroundMode: continuable)
  └─ 子代理 = dsh 进程内 child agent(会话可常驻,send_message 可续聊)
       └─ 每次 LLM 调用 → CodebuddyLlmAdapter → spawn `codebuddy -p --output-format stream-json`
            └─ 翻译文本与工具步骤(tool/call + tool/result)回 dsh 会话
```

- 子代理会话生命周期由 dsh 提供；每次调用把该子代理自己的完整历史序列化进 prompt。
- CodeBuddy 的模型、网络与配额由 CodeBuddy 侧负责，插件只做 LLM 适配桥接。

## 六、参与开发

```bash
pnpm install        # 安装 typescript + vitest
pnpm build          # tsc 编译 → lib/(产物随仓库提交,免构建安装)
pnpm test           # vitest 单元测试(serialize 等)
pnpm typecheck      # tsc --noEmit
```

提交前检查：`git status` 无遗留文件；lib/ 与测试同步更新。发布仅 git push（不做 npm publish）：

```bash
git add -A && git commit -m "feat/fix: ..." && git push origin master
```

## 七、许可证

MIT
