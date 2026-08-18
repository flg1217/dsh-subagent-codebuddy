# dsh-subagent-codebuddy

把腾讯 CodeBuddy Code CLI 接入 dsh 作为**子代理提供方**（LLM 适配器架构，对齐 dsh-llm-agy）：

```
tool-subagent(provider: spawn, backgroundMode: continuable)
  └─ 子代理 = dsh 进程内 child agent(会话可常驻,send_message 可续聊)
       └─ 每次 LLM 调用 → CodebuddyLlmAdapter → spawn `codebuddy -p --output-format stream-json`
            └─ 翻译文本与工具步骤(tool/call + tool/result)回 dsh 会话
```

## 能力与边界

| dsh 提供 | 子代理（CodeBuddy）自己拥有 |
|---|---|
| 子代理会话生命周期（continuable、`send_message` 续聊、并行互不干扰） | 系统提示词、工具面、模型、权限执行 |
| 每次调用把该子代理自己的完整历史序列化进 prompt（上下文由 dsh 管理，不依赖 CodeBuddy 存储） | CodeBuddy 进程内自主执行工具 |

**与"ACP 直接子代理"方案的区别**：子代理是 dsh 进程内 agent——每个子代理是独立会话，**可并行创建、可分别续聊**；上下文连续性由 dsh 子代理会话管理，不存在 CodeBuddy 按 cwd 自动续上下文造成的跨任务串味（实测 `codebuddy --acp` 会按工作目录自动续上一会话，参数无法隔离，故本插件不走 ACP）。

## 安装（发布后）

插件的 `cordis.patch.yml` 是**空 patch（模板注释）**——安装后在 profile 的 `cordis.patch.yml` 加入：

```yaml
- insert:
    - id: subagent-codebuddy
      name: '@dsh-external/dsh-subagent-codebuddy'
      config:
        command: codebuddy
        model: deepseek-v4-flash
        permissionMode: bypassPermissions
        providerName: codebuddy
        toolName: subagent_codebuddy
```

## 本地试跑（link 方式）

1. `pnpm install`（本插件目录）
2. 在 profile 目录（如 `~/.dsh/profiles/web`）：
   - `package.json` 的 `dependencies` 加 `"@dsh-external/dsh-subagent-codebuddy": "link:<本插件绝对路径>"`
   - `dsh.profile.bundles` 数组加 `"@dsh-external/dsh-subagent-codebuddy"`
   - `cordis.patch.yml` 加入上面的配置行
3. `pnpm install`
4. 重启 dsh web，重开会话后工具列表出现 `subagent_codebuddy`

## 配置

| 键 | 默认 | 含义 |
|---|---|---|
| `command` | `codebuddy` | 可执行文件（Windows 自动解析 npm cmd-shim → `node <真实CLI>`） |
| `model` | `deepseek-v4-flash` | CodeBuddy 模型 ID（`--model <id>`） |
| `permissionMode` | `bypassPermissions` | `--permission-mode`：子代理工具调用自动放行 |
| `extraArgs` | `[]` | 追加的 CodeBuddy 参数 |
| `providerName` | `codebuddy` | LLM provider 路由名 |
| `toolName` | `subagent_codebuddy` | 模型可见工具名 |
| `registerSubagentTools` | `true` | 是否注册委派工具 |

## 注意

- 需要 CodeBuddy 已登录（子进程继承登录态）。
- 子代理权限模式默认 `bypassPermissions`（全自动），如要更保守可改 `acceptEdits` 或 `plan`。
- 本插件只做 LLM 适配桥接；CodeBuddy 的模型、网络与配额由 CodeBuddy 侧负责。
