# dsh-subagent-codebuddy

> **CodeBuddy Code CLI 模型提供方 — DeepSeek Harness (dsh) 插件**
> 把腾讯 CodeBuddy CLI 以 ACP (Agent Client Protocol) 接入 dsh，注册为 `codebuddy` LLM provider：
> 主代理可直接在模型选择器选用 CodeBuddy 模型，通用 `subagent` 工具也可委派 CodeBuddy 子代理。
> 完全遵循 dsh 官方扩展机制，零源码改动。

## 一、这是什么

`codebuddy` 是一位**完整的模型供应商**（对齐 dsh-llm-agy 的架构）：

| 能力 | 说明 |
| --- | --- |
| **主代理模型** | 模型选择器出现 CodeBuddy 分组（模型目录 = `codebuddy --help` 解析 ∪ 配置默认模型），选中后该轮由 CodeBuddy CLI 全权驱动 |
| **子代理 provider** | 通用 dsh `subagent` 工具可传 `provider: codebuddy` 委派（配合 `subagent-model-selection` 设置）；进程内 child agent、可并行、`send_message` 续聊 |
| **模型目录** | adapter 实现 `listModels()`（带缓存、永不抛错），主选择器与 `list_subagent_models` 共用 |
| **推理强度** | CLI `--effort` 档位（low / medium / high / xhigh / max / ultracode）暴露到 dsh 模型选择器；子代理可用 `reasoning_effort` 参数指定 |
| **图片输入** | 图片块读字节后以 **ACP 原生 image 内容块**（base64）随 prompt 发送（`promptCapabilities.image`，不落盘、不受 CodeBuddy Read 工具 256KB 上限约束）；历史种子与子代理转录里的图片经 CodeBuddy blob（内容寻址）双向原生转换，两侧均可预览 |
| **子代理可视化** | codebuddy 轮里的 `Agent` 委派镜像为 **dsh 子会话**（`parentSession` 血缘 + `subagent/descriptor`），侧边栏可点开完整转录（消息/工具/思考/任务），运行中近实时跟随 |
| **任务/todo 桥接** | `TaskCreate` / `TaskUpdate` / `todo_write` 折算为 dsh `todo/write` 整表快照事件，主轮与子代理会话都复用 dsh 的 TodoPanel 渲染 |
| **opt-in 工具** | `subagent_codebuddy` + `list_codebuddy_models`（`registerSubagentTools: true` 开启；默认关闭，推荐通用工具） |

**语义说明（主代理轮）**：ACP CLI 自带完整 agent 循环与工具链——该轮由 CodeBuddy 执行自己的
工具（`--dangerously-skip-permissions`），**dsh 的沙箱/审批/工具不参与**，其步骤以会话事件回传
dsh（文本/思考/工具卡片实时可见）。

## 二、快速开始

### 系统要求

- dsh `>= 0.1.3-alpha.2`（验证于 0.1.3-alpha.2）
- CodeBuddy CLI 已安装并登录（子进程继承登录态）

### 安装插件

```bash
node scripts/link-profile.mjs            # 默认装配进 web profile
# 或等价于:dsh plugin --profile web add <本仓库目录>
```

插件行由插件自带的 `cordis.patch.yml`（bundle patch）自动注入，默认配置开箱即用。
需要覆盖默认值时，在 profile 的 `cordis.patch.yml` 用同 id 覆盖：

```yaml
- id: subagent-codebuddy
  config:
    model: <其他模型>          # 默认 deepseek-v4-flash
    registerSubagentTools: true # 需要 opt-in 工具时开启
```

重启 dsh web 后：模型选择器出现 **CodeBuddy** 分组。

### 主代理使用

新会话 → 模型选择器 → 选中 CodeBuddy 的某个模型（如 `deepseek-v4-flash`）→ 正常对话。
该轮由 CodeBuddy 驱动（含其自带工具），步骤/文本实时回传 dsh 界面。

### 子代理委派（通用工具）

1. 设置 → 子代理模型选择，把 codebuddy 路由加入允许列表（新顶层会话生效）：
   ```yaml
   subagent-model-selection:
     enabled: true
     allowedModels:
       - provider: codebuddy
         model: deepseek-v4-flash
   ```
2. 主代理调 `subagent` 工具，传 `provider: codebuddy`、`model: <id>`（model 为精确 id，
   目录见 `list_subagent_models` 或主模型选择器）。

### 动态模型选择

- adapter `listModels()`：从 `codebuddy --help` 实时解析支持列表（成功缓存 10 分钟），
  配置默认模型始终并入目录，CLI 不可用时回退配置模型、provider 仍可选择。
- opt-in 的 `list_codebuddy_models` 工具提供同样数据的文本视图。

### 配置项

| 键 | 默认 | 含义 |
|---|---|---|
| `command` | `codebuddy` | 可执行文件（Windows 自动解析 npm cmd-shim → `node <真实CLI>`） |
| `model` | `deepseek-v4-flash` | 默认 CodeBuddy 模型 ID（子代理委派缺省值；主代理选择器另选） |
| `permissionMode` | `bypassPermissions` | `--permission-mode`：CodeBuddy 工具调用自动放行 |
| `extraArgs` | `[]` | 追加的 CodeBuddy 参数 |
| `providerName` | `codebuddy` | LLM provider 路由名 |
| `toolName` | `subagent_codebuddy` | opt-in 工具名 |
| `registerSubagentTools` | `false` | 是否注册 opt-in 委派工具（推荐用通用 `subagent`） || `longToolCapMinutes` | `30` | 静默长工具硬顶（分钟，`0` = 关闭）：只影响**发起后零事件**的工具段（任何中间进展都会重置计时）；超顶中止本次调用并**自动续跑**——防止 CLI 卡死时进程泄漏、子会话回合悬空 |

## 三、工作原理

```
主代理轮:  会话模型选择器 → codebuddy/<id> → CodebuddyLlmAdapter
              └─ spawn codebuddy --acp → initialize → session/new|load → session/prompt
                   └─ session/update(思考/文本/工具)→ 写入调用方已打开的 step
               子代理轮:  通用 subagent(provider: spawn) → child agent → 同一 adapter
```

- **事件写入**:adapter 检测调用方（agent-loop）已打开的 turn/step，把 ACP 的
  思考/文本/工具事件直写进该 step（tool/call 前先以 assistant/message 广告，
  严格满足 dsh 会话格式 v2 关系校验）；辅助调用（压缩/标题，带 `purpose`）
  或没有打开 step 时退化为纯 chunk 流，不写会话。
- **历史原生转换**：已有对话切换到 codebuddy 时，折叠后的 dsh 历史由转换器写成
  CodeBuddy 原生会话文件（`~/.codebuddy/projects/<slug>/<sessionId>.jsonl`：
  user/assistant 消息 + function_call/result 记录），再 `session/load` 载入——
  历史以原生消息进入 CodeBuddy，而不是压成一段提示词文本。载入失败自动回退
  "新会话 + 全量提示词"。单条消息的新会话（如子代理首次委派）直接走 `session/new`。
- **会话续跑**:同一 dsh 会话映射到同一 ACP sessionId（`session/load` 回放复用，
  映射持久化在 `~/.dsh/codebuddy/conversations.json`，服务重启可恢复）；
  可重试失败（静默空跑/进程退出/超时）自动恢复续跑，用尽才显式报错；
  切换其他模型期间的缺失轮次在续聊时自动补发。
- **假死防御**:进展性 update 重置动态空闲阈值；**工具在途期间暂停计时**
  （ACP 工具无心跳，完成即重新起算）；静默超阈值先 `session/cancel`、5s 后 kill。
- CodeBuddy 的模型、网络与配额由 CodeBuddy 侧负责，插件只做桥接。

## 四、参与开发

```bash
pnpm install        # 安装 typescript + vitest（PowerShell）
pnpm build          # tsc 编译 → lib/（产物随仓库提交，免构建安装）
pnpm test           # vitest 单元测试
pnpm typecheck      # tsc --noEmit
```

提交前检查：`git status` 无遗留文件；`lib/` 与源码同步更新。发布仅 git push
（不做 npm publish）：

```bash
git add -A && git commit -m "feat/fix: ..." && git push origin master
```

## 五、许可证

MIT
