/**
 * CodeBuddy 子代理 → dsh 影子子会话镜像。
 *
 * codebuddy 驱动的轮次里,Agent 工具会派生 CodeBuddy 自己的子代理,其转录
 * 落在 `~/.codebuddy/projects/<slug>/<sessionId>/subagents/<agentId>.jsonl`
 * (与主会话同记录格式)。本模块把它实时镜像成 dsh 的**子会话**:
 *
 * - `sessions.create` 建带 lineage 的会话(header.parentSession + origin:
 *   'subagent'),侧边栏的子代理目录据此发现它;
 * - 写入 `subagent/descriptor`(投影据此分类 label/mode);
 * - 转录逐条转成 dsh 事件直写该会话(本会话没有 agent-loop,adapter 是
 *   唯一写入者,自行维护 turn/step 结构与工具广告/结果配对);
 * - 轮询文件做近实时跟随,Agent 调用结束时收尾(未决工具补错误结果,
 *   闭合 step/turn)。
 *
 * 事件序列与主会话同规:tool/call 前必有 assistant/message 广告(name/
 * arguments 逐字一致),step/end 时无未决工具——满足严格 v2 关系校验。
 * @module subagent-codebuddy/mirror
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { projectSlug } from './native-session.js'
import { readImageBlob } from './image-blob.js'
import { todoToolKind, TodoListState } from './todo-bridge.js'
import { imageReadAlias, toolResultBlocksFromText } from './tool-image.js'

/** 影子会话的最小操作面(sessions 服务)。 */
export interface ShadowSessionFace {
  create(
    id?: unknown,
    options?: { meta?: Record<string, unknown> },
  ): { readonly id: string; append: (type: string, data: unknown, opts?: unknown) => { readonly seq: number } | undefined }
}

/** 镜像依赖。 */
export interface MirrorDeps {
  /** sessions 服务(create 建影子会话)。 */
  sessions: ShadowSessionFace
  /** 父(dsh)会话 id。 */
  parentSessionId: string
  /** 子代理的工作目录(与 CodeBuddy 项目 slug 对齐)。 */
  cwd: string
  /** 父会话在 CodeBuddy 侧的 ACP sessionId(子代理目录名)。 */
  acpSessionId: string
  /** 子代理转录的目录根(默认 `~/.codebuddy/projects`;测试注入)。 */
  projectsRoot?: string
  /** 图片入库面(attachments 服务;缺省时图片退化为 `[图片]` 文本)。 */
  attachments?: MirrorImages
  /** 父会话的 agentPreset(影子会话头与其保持一致,便于分类/导航)。 */
  agentPreset?: string
  /** 轮询间隔(毫秒,默认 1500)。 */
  pollMs?: number
  /** 日志(默认静默)。 */
  log?: (message: string) => void
}

/** 一条 CodeBuddy 转录记录(宽松)。 */
interface NativeRecord {
  type?: string
  role?: string
  name?: string
  callId?: string
  arguments?: unknown
  status?: string
  output?: { type?: string; text?: string }
  content?: Array<{ type?: string; text?: string; blob_path?: string; mime?: string }>
  rawContent?: string
  summary?: string
  providerData?: { requestModelId?: string; model?: string }
}

/** 图片入库面:blob 字节 → dsh attachment 引用(saveImage 由 attachments 服务提供)。 */
export interface MirrorImages {
  saveImage: (data: Uint8Array, mediaType: string) => Promise<unknown>
}

/** 从 Agent 工具结果文本解析子代理 id(`[Agent ID: agent-xxx]`)。 */
export function agentIdFromOutput(text: string): string | undefined {
  return /\[Agent ID:\s*([^\]]+)\]/.exec(text)?.[1]?.trim()
}

/** 一批转录记录 → dsh 事件(纯函数,便于测试与官方校验器验证)。 */
export class RecordTranslator {
  private stepOpen = false
  private turnOpen = false
  private readonly callSeqs = new Map<string, number>()
  private readonly advertised = new Set<string>()
  /** 子代理的任务/todo(整表快照,镜像侧同桥接)。 */
  private readonly todos = new TodoListState()
  /** read_image 别名调用的 meta 路径(callId → path,结果落地时写 meta)。 */
  private readonly imageReadPaths = new Map<string, string>()

  constructor(
    private readonly append: (type: string, data: unknown, opts?: unknown) => unknown,
    private readonly model: string,
    private readonly images?: MirrorImages,
  ) {}

  /** 开头:turn + step + 描述符。 */
  begin(descriptor: { provider: string; label: string }): void {
    this.append('subagent/descriptor', { version: 3, mode: 'one-shot', provider: descriptor.provider, label: descriptor.label })
    this.append('turn/start', { turn: 1 })
    this.append('step/start', { turn: 1, step: 1 })
    this.turnOpen = true
    this.stepOpen = true
  }

  /** 收尾:未决工具补错误结果,闭合 step/turn。 */
  end(): void {
    for (const [callId] of this.callSeqs) {
      this.append('tool/result', {
        turn: 1,
        step: 1,
        message: createToolResultMessage({
          callId: ToolCallId(callId),
          content: [{ type: 'text', text: 'subagent turn ended before this tool reported completion.' }],
          isError: true,
        }),
      }, { surfaceOp: 'append' })
    }
    this.callSeqs.clear()
    this.advertised.clear()
    if (this.stepOpen) {
      this.append('step/end', { turn: 1, step: 1 })
      this.stepOpen = false
    }
    if (this.turnOpen) {
      this.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      this.turnOpen = false
    }
  }

  /** 应用一条转录记录(图片需异步入库)。 */
  async apply(record: NativeRecord): Promise<void> {
    switch (record.type) {
      case 'message': {
        const text = (record.content ?? [])
          .filter(block => block.type === 'input_text' || block.type === 'output_text')
          .map(block => block.text ?? '')
          .join('')
        if (record.role === 'assistant') {
          if (text.length === 0) return
          this.append('assistant/message', {
            turn: 1,
            step: 1,
            message: createAssistantMessage({
              content: [{ type: 'text', text }],
              source: { provider: 'codebuddy', model: this.model },
            }),
          }, { surfaceOp: 'append' })
          return
        }
        // 用户消息:文本 + 图片(blob → dsh attachment,消息栏可直接预览)。
        const blocks: Array<Record<string, unknown>> = []
        if (text.length > 0) blocks.push({ type: 'text', text })
        for (const block of record.content ?? []) {
          if (block.type !== 'image_blob_ref') continue
          const stored = block.blob_path === undefined ? undefined : readImageBlob(block.blob_path)
          if (stored !== undefined && this.images !== undefined) {
            try {
              const ref = await this.images.saveImage(stored.data, stored.mediaType)
              blocks.push({ type: 'image', attachment: ref })
              continue
            } catch { /* 入库失败:退化为占位 */ }
          }
          blocks.push({ type: 'text', text: '[图片]' })
        }
        if (blocks.length === 0) return
        this.append('user/message', createUserMessage({
          content: blocks as never,
          source: { kind: 'user' },
        }), { surfaceOp: 'append' })
        return
      }
      case 'reasoning': {
        const text = record.rawContent ?? ''
        if (text.length === 0) return
        this.append('assistant/message', {
          turn: 1,
          step: 1,
          message: createAssistantMessage({
            content: [{ type: 'reasoning', text }],
            source: { provider: 'codebuddy', model: this.model },
          }),
        }, { surfaceOp: 'append' })
        return
      }
      case 'function_call': {
        if (record.callId === undefined) return
        const args = typeof record.arguments === 'string' ? record.arguments : JSON.stringify(record.arguments ?? {})
        const name = record.name ?? 'tool'
        // 图片文件的 Read → dsh 原生 `read_image`(UI 图片卡片按此名 + 结果的
        // meta.path 渲染缩略图;广告与 call 同名同参,逐字一致校验不受影响)。
        const alias = imageReadAlias(name, args)
        const dshName = alias?.name ?? name
        if (alias !== undefined) this.imageReadPaths.set(record.callId, alias.path)
        // 广告 + call(name/arguments 逐字一致,严格校验要求)。
        this.append('assistant/message', {
          turn: 1,
          step: 1,
          message: createAssistantMessage({
            content: [{ type: 'tool-call', id: ToolCallId(record.callId), name: dshName, arguments: args }],
            source: { provider: 'codebuddy', model: this.model },
          }),
          stream: [],
        }, { surfaceOp: 'append' })
        const event = this.append('tool/call', {
          turn: 1,
          step: 1,
          callId: ToolCallId(record.callId),
          name: dshName,
          arguments: args,
        }) as { seq?: number } | undefined
        if (typeof event?.seq === 'number') this.callSeqs.set(record.callId, event.seq)
        this.advertised.add(record.callId)
        // 任务/todo 工具 → 折算整表落地(UI TodoPanel;TaskUpdate 延到结果确认)。
        const kind = todoToolKind(name)
        if (kind !== undefined) {
          let parsed: Record<string, unknown> = {}
          try {
            parsed = (typeof record.arguments === 'string' ? JSON.parse(record.arguments) : record.arguments) as Record<string, unknown>
          } catch { /* 参数非法则跳过 */ }
          if (kind === 'taskupdate') {
            this.todos.deferTaskUpdate(record.callId, parsed)
          } else if (Object.keys(parsed).length > 0 && this.todos.applyToolCall(name, parsed)) {
            this.append('todo/write', { todos: this.todos.snapshot() })
          }
        }
        return
      }
      case 'function_call_result': {
        if (record.callId === undefined) return
        const text = record.output?.text ?? ''
        const toolName = record.name ?? ''
        this.todos.applyToolResult(toolName, text)
        if (this.todos.resolveTaskUpdate(record.callId, text)) {
          this.append('todo/write', { todos: this.todos.snapshot() })
        }
        const isError = record.status !== undefined && record.status !== 'completed' && record.status !== 'success'
        const imagePath = this.imageReadPaths.get(record.callId)
        this.imageReadPaths.delete(record.callId)
        // 图片结果(CLI 以文本 JSON 交付):落 attachment 转 image 块,
        // 与原生 read_image 同形状;非图片/失败保持原文(限长)。
        let content: Array<Record<string, unknown>> = [{ type: 'text', text: text.slice(0, 4000) }]
        if (!isError) {
          const face = this.images === undefined
            ? undefined
            : { saveImage: (input: { data: Uint8Array; mediaType: string }): Promise<unknown> => this.images!.saveImage(input.data, input.mediaType) }
          const converted = await toolResultBlocksFromText(face, text, imagePath)
          if (converted !== undefined) content = converted
        }
        const seq = this.callSeqs.get(record.callId)
        this.append('tool/result', {
          turn: 1,
          step: 1,
          message: createToolResultMessage({
            callId: ToolCallId(record.callId),
            content: content as never,
            isError,
          }),
          ...(imagePath === undefined ? {} : { meta: { path: imagePath } }),
        }, {
          surfaceOp: 'append',
          ...(seq === undefined ? {} : { sourceEventSeqs: [seq] }),
        })
        this.callSeqs.delete(record.callId)
        this.advertised.delete(record.callId)
        return
      }
      default:
        return
    }
  }
}

/**
 * 一个 Agent 调用的镜像:建影子会话 → 跟随转录文件 → 收尾。
 */
export class SubagentMirror {
  private readonly pollMs: number
  private readonly root: string
  private readonly log: (message: string) => void
  private shadow:
    | { readonly id: string; append: (type: string, data: unknown, opts?: unknown) => { readonly seq: number } | undefined }
    | undefined
  private translator: RecordTranslator | undefined
  private file: string | undefined
  private offset = 0
  private startedAt = 0
  private prompt = ''
  private timer: ReturnType<typeof setInterval> | undefined
  private finished = false

  /** 影子会话 id(创建后可用,供外部引用)。 */
  get shadowId(): string | undefined {
    return this.shadow?.id
  }

  constructor(private readonly deps: MirrorDeps) {
    this.pollMs = deps.pollMs ?? 1_500
    this.root = deps.projectsRoot ?? join(homedir(), '.codebuddy', 'projects')
    this.log = deps.log ?? ((): void => {})
  }

  /** 子代理转录目录。 */
  private subagentsDir(): string {
    return join(this.root, projectSlug(this.deps.cwd), this.deps.acpSessionId, 'subagents')
  }

  /** 开始镜像:建影子会话并进入跟随。 */
  start(agent: { label: string; prompt: string; delegationDepth: number }): void {
    if (this.shadow !== undefined || this.finished) return
    try {
      this.shadow = this.deps.sessions.create(undefined, {
        meta: {
          cwd: this.deps.cwd,
          parentSession: this.deps.parentSessionId,
          origin: 'subagent',
          delegationDepth: agent.delegationDepth,
          createdAt: Date.now(),
          ...(this.deps.agentPreset === undefined ? {} : { agentPreset: this.deps.agentPreset }),
        },
      }) as unknown as SubagentMirror['shadow']
    } catch (error) {
      this.log(`mirror: create shadow session failed: ${String(error)}`)
      return
    }
    this.startedAt = Date.now()
    this.prompt = agent.prompt
    const shadow = this.shadow!
    this.translator = new RecordTranslator(
      (type, data, opts) => shadow.append(type, data, opts),
      'codebuddy',
      this.deps.attachments,
    )
    this.translator.begin({ provider: 'codebuddy', label: agent.label })
    this.timer = setInterval(() => { void this.syncOnce() }, this.pollMs)
    this.timer.unref?.()
    void this.syncOnce()
    this.log(`mirror: shadow session ${shadow.id} started for "${agent.label}"`)
  }

  /** 定位转录文件(新建、未被占用、提示词前缀匹配优先)。 */
  private locateFile(): string | undefined {
    let entries: string[]
    try {
      entries = readdirSync(this.subagentsDir()).filter(name => name.endsWith('.jsonl'))
    } catch {
      return undefined
    }
    const candidates = entries
      .map(name => join(this.subagentsDir(), name))
      .filter(path => {
        try {
          return statSync(path).mtimeMs >= this.startedAt - 5_000
        } catch {
          return false
        }
      })
    // 提示词前缀匹配(转录首条 user 消息 = 委派提示词);否则取最新。
    const prefix = this.prompt.trim().slice(0, 40)
    for (const path of candidates) {
      try {
        const first = readFileSync(path, 'utf8').split('\n').find(line => line.includes('"input_text"'))
        if (first !== undefined && prefix.length > 0 && first.includes(JSON.stringify(prefix).slice(1, -1))) return path
      } catch { /* 读失败跳过 */ }
    }
    return candidates[0]
  }

  /** 拉取一次增量(也由测试直接调用)。内部全量容错:镜像失败绝不能拖垮主轮。 */
  async syncOnce(): Promise<void> {
    try {
      await this.syncOnceUnsafe()
    } catch (error) {
      this.log(`mirror: sync failed (shadow ${this.shadow?.id ?? '?'}): ${String(error).slice(0, 200)}`)
    }
  }

  /** 增量读取主体;异常由 {@link syncOnce} 兜底。 */
  private async syncOnceUnsafe(): Promise<void> {
    if (this.translator === undefined || this.finished) return
    if (this.file === undefined) {
      this.file = this.locateFile()
      if (this.file === undefined) return
    }
    let lines: string[]
    try {
      lines = readFileSync(this.file, 'utf8').split('\n').filter(line => line.length > 0)
    } catch {
      return
    }
    while (this.offset < lines.length) {
      let record: NativeRecord
      try {
        record = JSON.parse(lines[this.offset]!) as NativeRecord
      } catch {
        return // 半行(正在追加):下轮再读
      }
      this.offset += 1
      // 跳过文件头类记录(本文件通常无 header,防御即可)。
      if (record.type === 'session-meta' || record.type === 'file-history-snapshot' || record.type === 'ai-title') continue
      await this.translator.apply(record)
    }
  }

  /** 收尾:终读一次,闭合结构与计时器(全量容错,同 {@link syncOnce})。 */
  async finish(agentId?: string): Promise<void> {
    try {
      if (this.finished) return
      if (agentId !== undefined && this.file === undefined) {
        const candidate = join(this.subagentsDir(), `${agentId}.jsonl`)
        try {
          statSync(candidate)
          this.file = candidate
        } catch { /* 文件不在则终读原文件 */ }
      }
      await this.syncOnceUnsafe()
      try {
        this.translator?.end()
      } catch (error) {
        this.log(`mirror: close failed (shadow ${this.shadow?.id ?? '?'}): ${String(error).slice(0, 200)}`)
      }
      this.log(`mirror: shadow session ${this.shadow?.id ?? '(none)'} finished`)
    } finally {
      this.finished = true
      if (this.timer !== undefined) {
        clearInterval(this.timer)
        this.timer = undefined
      }
    }
  }
}
