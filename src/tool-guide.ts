/**
 * 模型在 CodeBuddy 与 dsh 原生之间切换时,注入**工具面说明**。
 *
 * dsh 核心只注入一条"模型变了"(core/agent 的 modelSwitchNotice:assistant
 * 历史由旧模型生成、会话继续用新模型)。但两条路由的工具面是**两套**:
 *
 * - CodeBuddy 回合内:CLI 原生工具(Bash/Read/Edit/Write/Glob/Grep 等)全禁,
 *   一律走 dsh 桥工具(mcp__dsh__* / dsh_* 委托);
 * - dsh 原生回合:工具恢复原生形态,而桥的**回放代理**(cli_ 前缀,记录 CLI
 *   曾调用过的原生工具)只在其回合内有效。
 *
 * 这条差异不注入,切换后的第一步模型就会按上一个模型的习惯选错工具
 * (实测:codebuddy → dsh 原生后误选残留 cli_* 读图工具,报"没有运行中的
 * CodeBuddy 回合"而损坏读图)。
 *
 * 时机:`model/selection` 事件记下切换,下一次 pre-step 注入(空步会丢消息,
 * 与 modelSwitchNotice 同一守卫——空步保留待注入,等真正发请求的那一步)。
 * @module subagent-codebuddy/tool-guide
 */

import type { Context } from '@deepseek-ai/cordis'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'

/** 消息 source.plugin 名。 */
const PLUGIN_NAME = 'codebuddy'

/** 从 session/event 载荷取会话 id(与 pump 的取法一致)。 */
function sessionIdOf(session: unknown): string | undefined {
  const face = session as { id?: unknown; header?: { id?: unknown } } | undefined
  const id = face?.header?.id ?? face?.id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/**
 * 切换说明文本;与 CodeBuddy 无关的切换(两边都不是)返回 undefined。
 * @param from - 切换前路由的 provider(会话首个选择时为 undefined)。
 * @param to - 切换后路由的 provider。
 */
function guideText(from: string | undefined, to: string): string | undefined {
  if (to === PLUGIN_NAME) {
    return '[工具面切换:当前路由是 CodeBuddy 桥] CodeBuddy CLI 的原生工具'
      + '(Bash/Read/Edit/Write/Glob/Grep 等)在该回合内全部禁用——一律改用 dsh 桥工具'
      + ' mcp__dsh__<工具名>(bash、pwsh、read、read_image、write、edit、glob、grep、subagent、'
      + 'send_message…);它们在 dsh 侧执行,受审批/沙箱约束并进会话日志。'
  }
  if (from === PLUGIN_NAME) {
    return '[工具面切换:当前路由是 dsh 原生模型] 工具恢复 dsh 原生形态'
      + '(read、write、edit、pwsh、read_image、glob、grep…直接调用);CodeBuddy 桥的回放代理'
      + '(cli_ 前缀,只在 CodeBuddy 回合内有效)不要使用。'
  }
  return undefined
}

/**
 * 安装"路由切换 → 工具面说明"注入。
 * @param ctx - 插件上下文(session/event 与 agent/pre-step 两个事件面)。
 */
export function installModelSwitchToolGuide(ctx: Context): void {
  /** 会话 → 最近一次选中的 provider。 */
  const lastRoute = new Map<string, string>()
  /** 会话 → 待注入的工具面切换(from → to);下一次可用 pre-step 消费。 */
  const pending = new Map<string, { from: string | undefined; to: string }>()

  ctx.on('session/event', (...args: unknown[]) => {
    const event = args[1] as { type?: unknown; data?: unknown } | undefined
    if (event?.type !== 'model/selection') return
    const id = sessionIdOf(args[0])
    if (id === undefined) return
    const to = (event.data as { provider?: unknown } | undefined)?.provider
    if (typeof to !== 'string' || to.length === 0) return
    const from = lastRoute.get(id)
    lastRoute.set(id, to)
    if (from === to) return
    // 与 CodeBuddy 无关的切换(如原生模型之间):不注入,仅更新路由记忆。
    if (guideText(from, to) === undefined) return
    pending.set(id, { from, to })
  })

  ctx.on('agent/pre-step', async ({ agent, messages, signal, step }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    const id = agent.session.header.id
    const target = pending.get(id)
    if (target === undefined) return decision
    // 空步会被 loop 跳过(本步没有可发送内容):注入会随空步丢失——保留待注入。
    if (decision.messages.length === 0 && (step === 1 || messages.length > 0)) return decision
    pending.delete(id)
    const text = guideText(target.from, target.to)
    if (text === undefined) return decision
    return {
      ...decision,
      messages: [...decision.messages, createUserMessage({
        content: [{ type: 'text', text }],
        source: {
          kind: 'plugin',
          plugin: PLUGIN_NAME,
          form: 'notice',
          summary: boundContextSummary(`tools: ${target.from ?? '(new)'} → ${target.to}`),
        },
      })],
    }
  })
}
