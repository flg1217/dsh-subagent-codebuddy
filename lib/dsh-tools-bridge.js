/**
 * dsh 工具 → CodeBuddy 委托工具的**通用桥**。
 *
 * CodeBuddy 的 delegate tools 机制只要求 `{id,name,description,inputSchema}`:
 * 把 dsh 侧当前会话可见的全部工具(含 MCP)自动注册为 `dsh_<原名>` 委托工具,
 * 模型调用时经 `ctx.tools.execute` 走 dsh 的**完整执行管线**——审批、沙箱、
 * 事件与追踪和原生执行完全一致——结果回灌给 CLI。
 *
 * 命名与排除:
 * - 统一前缀 `dsh_`(与 CLI 自带同名工具区分,模型一眼看出是 dsh 侧);
 * - 排除 `bash`/`pwsh`(执行类已有 dsh_bash:job 化 + 完成通知 + 面板可见)
 *   与 `subagent`(已有 dsh_subagent 专用委托)、`run_code`(ptc 保留名);
 * - 剩余工具(读/搜/写/MCP…)全量桥接——工具集由 dsh 的 per-agent scope
 *   过滤决定,插件不重复维护清单;
 * - `cli_` 前缀是会话内 CLI 镜像代理的保留名(见 {@link CLI_MIRROR_TOOL_PREFIX}),
 *   既不暴露给 CLI 也不受理桥调用。
 *
 * @module subagent-codebuddy/dsh-tools-bridge
 */
import { randomUUID } from 'node:crypto';
/** 桥工具 id 前缀。 */
export const BRIDGE_TOOL_PREFIX = 'dsh_';
/**
 * 会话内「CLI 镜像工具」的保留前缀(pump 的 `ensureReplayTool` 注册的回放代理)。
 *
 * 为什么必须有这个前缀:CLI 原生工具(read/bash/…)的调用要进 dsh 会话,就得
 * 在会话 agent scope 里注册一个**同名**代理工具承接(等 CLI 的真实结果)。但
 * 同名注册会**遮蔽 dsh 真工具**——CLI 用过原生 `read` 后,桥的 `dsh_read` 经
 * `ctx.tools.execute` 命中镜像代理,拿到「未知的工具调用(该调用不属于当前回合)」
 * (实测:模型据此判定 dsh_read 坏掉,整轮对话开始乱试)。
 * 让镜像统一叫 `cli_read`,与真工具彻底分名,桥照旧解析真 `read`。
 */
export const CLI_MIRROR_TOOL_PREFIX = 'cli_';
/**
 * 不桥接的 dsh 工具名。
 *
 * 完全统一:bash/pwsh/subagent 等全部走桥(指向 dsh 原生工具——原生
 * subagent 本就是 continuable、原生 bash 支持 run_in_background→dsh jobs)。
 * 排除两类:
 * - `run_code`(ptc 模式的保留名,原生模式暴露无意义);
 * - **MCP 工具**(`mcp__*`)——它们走 CLI 的原生 MCP 通道(见 mcp 接入),
 *   不经工具桥往返。
 */
const BRIDGE_EXCLUDED = new Set(['run_code']);
/** MCP 工具名前缀(dsh 与 CLI 同名约定)。 */
const MCP_TOOL_PREFIX = 'mcp__';
/**
 * 被 CLI 镜像工具占用的 dsh 工具名:不桥接、不受理。
 *
 * `read_image`:CLI 原生 Read 读图时,泵把这次调用以镜像工具 `read_image` 记进
 * dsh 会话——**名字必须与真工具一致**:dsh Web UI 的图片卡片按
 * `call.name === 'read_image'` 才出预览(image-card-model 硬编码),改名就退化成
 * 普通文本行(实测)。真工具因此被镜像遮蔽,桥便不再暴露 `dsh_read_image`
 * (调了也会打到镜像上):CLI 自带 Read 读图已覆盖该能力,且结果同样进 dsh。
 */
const BRIDGE_MIRROR_OWNED = new Set(['read_image']);
/** 执行类工具的桥描述补充:强引导后台任务语义(默认后台 = dsh job)。 */
const EXECUTION_TOOLS = new Set(['bash', 'pwsh']);
const EXECUTION_HINT = ' IMPORTANT: for anything that may run more than a few seconds, pass `run_in_background: true` —'
    + ' the job then appears in the dsh background-jobs view and its completion notice wakes you to continue;'
    + ' a foreground call blocks until the command finishes (and may hit the delegate timeout).';
/** dsh 工具名 → 桥工具 id。 */
export function bridgeToolId(name) {
    return `${BRIDGE_TOOL_PREFIX}${name}`;
}
/**
 * 模型填写的 toolId 规范化为 dsh 原名。
 *
 * 模型对 DelegateTool 的 toolId 填写不稳定(实测:会把展示名 `Dsh-bash`
 * 当 toolId 传,也出现 `dsh-bash` 这类连字符变体)——统一剥前缀
 * (dsh_ / Dsh- / dsh-)、连字符归一为下划线、小写化(dsh 工具原名全小写,
 * 无损)。解析不出的原样返回,由调用方给 unknown 错误。
 */
function canonicalBridgeName(toolId) {
    const raw = toolId.replace(/^(?:dsh_|Dsh-|dsh-)/, '');
    return raw.replace(/-/g, '_').toLowerCase();
}
/** 桥工具 id → dsh 工具名;非桥命名、ptc 保留名、MCP 或 CLI 镜像名时返回 undefined。 */
export function bridgeTargetTool(toolId) {
    const name = canonicalBridgeName(toolId);
    if (name.length === 0 || BRIDGE_EXCLUDED.has(name) || name.startsWith(MCP_TOOL_PREFIX))
        return undefined;
    // CLI 镜像代理不暴露、也不受理(它只在会话 scope 里承接 CLI 原生调用)。
    if (name.startsWith(CLI_MIRROR_TOOL_PREFIX))
        return undefined;
    // 被镜像占名的 dsh 工具:调了只会打到镜像上,不认。
    if (BRIDGE_MIRROR_OWNED.has(name))
        return undefined;
    return name;
}
/** CLI 展示名:唯一、可读(`dsh_grep` → `Dsh-grep`)。 */
function bridgeToolName(name) {
    return `Dsh-${name.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 60)}`;
}
/** 桥工具描述:原描述原样保留,只加最短身份标记(桥语义引导在 prompt 尾注,不逐工具拼说明)。 */
function bridgeDescription(name, original) {
    const head = original.trim().length > 0
        ? `${original.trim()}`
        : `(the dsh-side tool "${name}")`;
    return `[dsh-side tool: "${name}"] ${head}`;
}
/**
 * 列出当前会话可见、应当桥接的全部 dsh 工具(delegate tool 描述符)。
 * 工具集来自 `ctx.tools.schemas(agent)`——dsh 的 per-agent scope 过滤已生效。
 * @param ctx - 插件上下文(tools 服务)。
 * @param parent - 会话的 agent(scope 与执行归属)。
 * @returns 桥工具描述符(不含专用委托工具)。
 */
export function listDshBridgeTools(ctx, parent) {
    const tools = ctx.get?.('tools');
    let schemas;
    try {
        schemas = tools?.schemas?.(parent) ?? [];
    }
    catch {
        return [];
    }
    const specs = [];
    for (const schema of schemas) {
        if (typeof schema?.name !== 'string' || schema.name.length === 0)
            continue;
        if (BRIDGE_EXCLUDED.has(schema.name))
            continue;
        // MCP 工具走 CLI 原生 MCP 通道,不经桥。
        if (schema.name.startsWith(MCP_TOOL_PREFIX))
            continue;
        // CLI 镜像代理不是真工具,别暴露给 CLI(它的 schema/描述对模型是噪音)。
        if (schema.name.startsWith(CLI_MIRROR_TOOL_PREFIX))
            continue;
        // 被镜像占名的工具不桥接(见 BRIDGE_MIRROR_OWNED)。
        if (BRIDGE_MIRROR_OWNED.has(schema.name))
            continue;
        const base = bridgeDescription(schema.name, typeof schema.description === 'string' ? schema.description : '');
        specs.push({
            id: bridgeToolId(schema.name),
            name: bridgeToolName(schema.name),
            description: EXECUTION_TOOLS.has(schema.name) ? base + EXECUTION_HINT : base,
            inputSchema: (schema.parameters !== null && typeof schema.parameters === 'object'
                ? schema.parameters
                : { type: 'object', properties: {} }),
        });
    }
    return specs;
}
/** 内容块数组 → 文本(text 原样;tool-result 递归;图片/结构化降级)。 */
function blocksToText(content) {
    const parts = [];
    for (const block of content) {
        if (block === null || typeof block !== 'object')
            continue;
        const typed = block;
        if (typed.type === 'text' && typeof typed.text === 'string') {
            parts.push(typed.text);
            continue;
        }
        if (typed.type === 'tool-result' && Array.isArray(typed.content)) {
            const inner = blocksToText(typed.content);
            if (inner.length > 0)
                parts.push(inner);
            continue;
        }
        if (typed.type === 'image') {
            parts.push('[image result — not forwarded as an image over this bridge]');
            continue;
        }
        try {
            parts.push(JSON.stringify(block));
        }
        catch { /* 不可序列化块跳过 */ }
    }
    const text = parts.join('\n');
    return text.length > 0 ? text : '(no output)';
}
/**
 * 执行一次桥接的 dsh 工具调用。
 * @param ctx - 插件上下文(agents / tools 服务)。
 * @param options - 调用参数。
 * @returns CLI 侧 DelegateTool 的响应对象(永不抛错——错误按协议回 status:'error')。
 */
export async function runDshBridgeTool(ctx, options) {
    const parent = ctx.get('agents')?.get(options.parentSessionId);
    if (parent === undefined) {
        return { status: 'error', error: { message: `dsh tool "${options.toolName}": parent agent "${options.parentSessionId}" is not live` } };
    }
    const tools = ctx.get('tools');
    if (tools === undefined) {
        return { status: 'error', error: { message: `dsh tool "${options.toolName}": the tools service is unavailable` } };
    }
    try {
        const result = await tools.execute({
            callId: randomUUID(),
            name: options.toolName,
            arguments: options.input,
            agent: parent,
            signal: options.signal ?? new AbortController().signal,
        });
        const text = blocksToText(result.content);
        return result.isError
            ? { status: 'error', error: { message: text } }
            : { status: 'success', output: text };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { status: 'error', error: { message: `dsh tool "${options.toolName}" failed: ${message}` } };
    }
}
