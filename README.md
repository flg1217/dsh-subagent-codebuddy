# dsh-subagent-codebuddy

把腾讯 CodeBuddy Code CLI 接入 dsh 作为 **ACP 子代理提供方**：主代理委派时，插件 spawn 一个 `codebuddy --acp` 子进程，按 [Agent Client Protocol](https://agentclientprotocol.com) 驱动它独立完成任务并把结果回传。

## 能力与边界

| dsh 提供 | 子代理（CodeBuddy）自己拥有 |
|---|---|
| 委派 prompt、工作区 cwd（`inheritsParentContext: false`） | 系统提示词、工具面、模型、权限模型 |
| 子进程环境（凭据 scrub + 显式 env）、权限自动应答、生命周期销毁 | ACP 服务端完整运行时 |

子代理是独立运行时：**不使用 dsh 的系统提示词与工具**。dsh 负责编排、持久化与进程生命周期。

## 安装（发布后）

插件的 `cordis.patch.yml` 是**模板**（默认不自动插入，避免与 profile 配置重复冲突）。安装后在 profile 的 `cordis.patch.yml` 加入：

```yaml
- insert:
    - id: subagent-codebuddy
      name: '@dsh-external/dsh-subagent-codebuddy'
      config:
        command: codebuddy
        args: ['--acp']
        providerName: codebuddy
        toolName: subagent_codebuddy
        model: deepseek-v4-flash
        permission: allow
```

或参考 `cordis.patch.yml` 内的注释模板。

## 本地试跑（link 方式）

1. `pnpm install`（本插件目录）
2. 在 profile 目录（如 `~/.dsh/profiles/web`）：
   - `package.json` 的 `dependencies` 加 `"@dsh-external/dsh-subagent-codebuddy": "link:<本插件绝对路径>"`
   - `dsh.profile.bundles` 数组加 `"@dsh-external/dsh-subagent-codebuddy"`
   - `cordis.patch.yml` 加入上面的配置行模板
3. `pnpm install`
4. 重启 dsh web，重开会话后工具列表出现 `subagent_codebuddy`

## 配置

| 键 | 默认 | 含义 |
|---|---|---|
| `command` | `codebuddy` | 可执行文件 |
| `args` | `['--acp']` | 启动参数（ACP 模式） |
| `model` | `deepseek-v4-flash` | CodeBuddy 模型 ID，追加 `--model <id>` |
| `providerName` | `codebuddy` | ctx.subagents 提供方名 |
| `toolName` | `subagent_codebuddy` | 模型可见工具名 |
| `permission` | `reject` | 子代理权限请求自动应答：`allow` / `reject` |
| `cwd` | 父会话 cwd | 子进程工作目录覆盖 |
| `env` | `{}` | 显式子进程环境（叠加在 scrub 后的父环境上） |

```yaml
- id: subagent-codebuddy
  name: '@dsh-external/dsh-subagent-codebuddy'
  config:
    command: codebuddy
    args: ['--acp']
    model: custom-local:gpt-5.6-luna
    permission: allow
```

需要多模型并存时,注册多个提供方实例(不同 `providerName`/`toolName`/`model`),
主代理按工具名选择委派目标。

## 注意

- 需要 CodeBuddy 已登录（子进程继承登录态）。
- 子代理深度上限由 CodeBuddy 自己管理（`maxDepth: provider-managed`）。
- 该插件只做 ACP 桥接；CodeBuddy 的模型、网络与配额由 CodeBuddy 侧负责。
