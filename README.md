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
| **工具桥（MCP / delegate）** | 把本会话可见的 dsh 工具暴露给 CodeBuddy，使它的文件/命令类能力走 dsh 管线（审批/沙箱/审计/后台面板）。默认 `mcp`：dsh 起 HTTP MCP server，工具以 `mcp__dsh__<名>` 一等公民呈现（完整 JSON Schema 强约束）；`delegate` 为旧通道（`dsh_<名>` 合成 DelegateTool），保留作回退 |
| **opt-in 工具** | `subagent_codebuddy` + `list_codebuddy_models`（`registerSubagentTools: true` 开启；默认关闭，推荐通用工具） |
| **压缩归属** | codebuddy 会话的压缩由 **CLI 负责**（dsh 的自动压缩被插件接管，不压镜像）；CLI 压完之后镜像成 dsh 的标准压缩卡，**零 token**（见 §三「压缩归属」） |

**语义说明（主代理轮，重要）**：ACP CLI 自带 agent 循环，但它的**文件/命令类原生工具已被
白名单移除**（spawn 传 `--tools`，见 §三「工具桥」）。因此：

- 需要读写文件、执行命令时，模型**必须**改用 dsh 侧工具（MCP 模式下是 `mcp__dsh__bash`
  / `mcp__dsh__edit` …，delegate 模式下是 `dsh_bash` / `dsh_edit` …）。这些调用**在 dsh 侧
  执行，受 dsh 的沙箱与审批约束**，并进会话日志、审计与后台任务面板。
- 仍留在 CLI 侧原生执行的只有白名单里的机制类/只读工具：`Read`（读图片必须走它，
  结果镜像为图片卡片）、`WebSearch`、`WebFetch`、`Task*`、`Skill`、`ToolSearch`、
  `DeferExecuteTool`、`DelegateTool`。
- 文本/思考/工具卡片仍以会话事件实时回传 dsh 界面。

> 历史注记：早期版本确实让 CLI 用自己的工具链、dsh 沙箱不参与；引入工具白名单 +
> 工具桥后已改变——**安全模型以本节为准**。

## 二、快速开始

### 系统要求

- dsh `>= 0.1.3-alpha.2`（验证于 0.1.3-alpha.2）
- CodeBuddy CLI 已安装并登录（子进程继承登录态）
- 需运行在**带 `webServer` 服务的 profile**（如 `web`）：`bridgeMode: mcp` 依赖它挂
  MCP 端点；拿不到该服务时端点不注册，`--mcp-config` 不注入（不会报错，但工具桥不可用）

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
    bridgeMode: delegate        # 工具桥回退到旧通道（默认 mcp）
```

> 设置面板（设置 → 插件 → CodeBuddy）也可改模型与工具桥开关，**表单值优先于本文件**。

重启 dsh web 后：模型选择器出现 **CodeBuddy** 分组。

### 主代理使用

新会话 → 模型选择器 → 选中 CodeBuddy 的某个模型（如 `deepseek-v4-flash`）→ 正常对话。
该轮由 CodeBuddy 驱动；它的文件/命令类工具经工具桥回到 dsh 执行（见 §一「语义说明」），
步骤/文本实时回传 dsh 界面。

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
| `registerSubagentTools` | `false` | 是否注册 opt-in 委派工具（推荐用通用 `subagent`） |
| `bridgeMode` | `mcp` | 工具桥模式：`mcp` = dsh 起 HTTP MCP server、工具以 `mcp__dsh__<名>` 呈现（完整 schema，推荐）；`delegate` = 旧 DelegateTool 通道（`dsh_<名>`，回退用）。设置面板有同名开关，**切换对新回合生效** |
| `longToolCapMinutes` | `30` | 静默长工具硬顶（分钟，`0` = 关闭）：只影响**发起后零事件**的工具段（任何中间进展都会重置计时）；超顶中止本次调用并**自动续跑**——防止 CLI 卡死时进程泄漏、子会话回合悬空 |
| `tailQuietSeconds` | `5` | 尾巴窗口静默阈值（秒，`0` = 关闭）：干净收尾后继续抽流，等 CLI 后台任务完成后的自发续跑 |
| `tailBgQuietMinutes` | `10` | 起了后台任务的回合的静默阈值（分钟） |
| `tailCapMinutes` | `30` | 尾巴窗口硬顶（分钟）：后台任务最长可拖着回合不闭合的时长 |

## 三、工作原理

```
主代理轮:  会话模型选择器 → codebuddy/<id> → CodebuddyLlmAdapter
              └─ spawn codebuddy --acp --tools <白名单> [--mcp-config <会话专属配置>]
                   → initialize → session/new|load → session/prompt
                   └─ session/update(思考/文本/工具)→ 写入调用方已打开的 step
              └─ 工具调用回流:CLI 调 mcp__dsh__<名> ──HTTP JSON-RPC──▶ dsh MCP 端点
                    └─ 伪装成工具调用块灌进 dsh loop → 原生执行(审批/沙箱/事件/UI 卡片)
                         └─ tool/result 回填 MCP 响应 ──▶ CLI 拿到结果继续
               子代理轮:  通用 subagent(provider: spawn) → child agent → 同一 adapter
```

### 工具桥（MCP / delegate）

CLI 原生工具经 `--tools` 白名单裁剪后（见 §一「语义说明」），文件/命令类能力必须由 dsh 提供。
插件把**当前会话可见的 dsh 工具**暴露给 CLI，两条通道：

| | `mcp`（默认） | `delegate`（回退） |
|---|---|---|
| 呈现 | `mcp__dsh__bash` / `mcp__dsh__edit` … | `dsh_bash` / `dsh_edit` …（合成 DelegateTool） |
| 参数约束 | 各工具**完整 JSON Schema**（协议下发，强约束） | 无结构 `input: object`（模型端几乎零约束） |
| 传输 | dsh 起 HTTP MCP server，CLI 每回合以 `--mcp-config` 连接 | ACP `session/request` 反向调用 |
| 工具集 | `tools/list` **每次现取**会话可见工具（不缓存） | 回合开始前批量注册 |

MCP 端点的安全约束：**仅 loopback 来源 + URL 携带每进程随机 key**（双重校验），挂在 dsh
自带 webserver 上（与 Web UI 同端口），不额外开监听；`tools/call` 另按 `tools/list` 的同一份
工具面校验可见性。会话专属配置写在系统临时目录，权限 `0600`，超龄自动清扫。

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

### 压缩归属（重要）

**codebuddy 会话的压缩由 CLI 负责，dsh 不参与。** 这不是可选项，是架构约束：dsh 只是渲染层，
真实上下文在 CLI 自己的会话文件里；而 dsh 的压力测量以 CLI 上报的 usage 为基线，它唯一能压的
却是 dsh 侧的镜像消息面 —— 压完压力不降 → 下一个 step 再触发；`compaction-basic` 的收缩闸门
（`summary is not smaller than the shadowed content`）在镜像面只剩旧摘要时必然拒绝，于是变成
**压缩风暴**（实测：11 分钟内 20+ 次 `compaction/start` → `compaction/end(error)`），
偶发成功的那几次还会把镜像面替换成摘要、把模型带偏。

实现方式（**零 dsh 源码改动**）：

| 路径 | 行为 |
|---|---|
| 自动压缩（`agent/pre-step` 的 pressure / `agent/request-error` 的 context-overflow） | 插件在 `ctx.compaction` 服务实例上接管 `compactIfNeeded`；codebuddy 路由的会话一律返回 `null` |
| 手动 `/compact` | per-agent 命令覆盖 → 转发给 CLI（跑在 `runMaintenance` 相位里，压缩期间消息按原生行为排队） |
| `compactNow` 兜底 | per-agent 覆盖没挂上时全局命令会走到它 → 同样接管，不压镜像 |
| **CLI 自己压完之后** | `compact-mirror` 把这次压缩镜像成 dsh 的一次压缩事务 → 界面出现标准压缩卡。**零 token**：照抄 CLI 的摘要原文，不调用任何模型，只有本地文件读取 + 日志写入 |

判据是**会话最新一次请求的路由 provider**（不是持久化的会话映射）——把 codebuddy 会话切回别的
provider 后，dsh 会恢复正常压缩。

> 压缩卡**不会隐藏或删除任何历史消息**：被遮蔽的消息照常渲染，dsh 的历史接口不做过滤。
> 压缩改的是 dsh 的 **surface**（上下文压力表，以及插件需要重建 CLI 上下文时的素材
> `buildPrompt` / 原生 seed）。

**启动自检与告警**（不会再静默失效）：插件装载时自检接管是否真的落到实例上，dsh 升级若改了
压缩入口，控制台会出现 `[subagent-codebuddy/compact] …未生效/未安装` 的 warn；正常接管时每个
codebuddy 会话播报一次 `已接管 <sessionId> 的 dsh 压缩`；镜像成功时播报
`[subagent-codebuddy/mirror] 已把 CodeBuddy CLI 的压缩镜像到 dsh 会话 <id>…`。

## 四、参与开发

```bash
pnpm install        # 安装 typescript + vitest（PowerShell）
pnpm build          # tsc 编译 → lib/（产物随仓库提交，免构建安装）
pnpm test           # vitest 单元测试
pnpm typecheck      # tsc --noEmit
```

> **`pnpm install` 目前只能在作者的机器上跑**：`package.json` 的 `devDependencies` 用了
> `link:D:/Projects/DeepseekHarness/repo/...` 这类**绝对路径**（指向 dsh 源码树，用于本地联调）。
> 换机器前需把它们改成正常的版本号（如 `>=0.1.3-alpha.2`）或 `workspace:*`。
> 仅**使用**插件（不构建）的人不受影响——运行时 `lib/` 只依赖相对路径与 peerDependencies。

### 分发与发布

分发走 **git（不做 npm publish）**：使用者把本仓库目录加进 profile 即可，`lib/` 已随仓库提交。

发布前检查：

1. `pnpm typecheck && pnpm test` 全绿；
2. `pnpm build` 且 **`lib/` 与 `src/` 同步**（`git status` 里 `lib/` 的改动应与 `src/` 一致——
   否则使用者拿到的是旧产物）；
3. README 的配置项表/能力表与实际 `Config` 一致；
4. `git status` 无遗留文件；
5. `git add -A && git commit -m "..." && git push origin master`。

## 五、许可证

MIT
