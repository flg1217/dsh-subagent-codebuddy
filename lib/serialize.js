/**
 * 序列化模块:把 dsh 消息翻译为 CodeBuddy 单轮 prompt。
 * - 系统提示(可选)、对话消息按顺序拼接为文本;
 * - 图片块读字节后以 **ACP 原生 image 内容块**(base64)随 prompt 发送
 *   (`promptCapabilities.image` 实测支持,不再落盘走路径——避开 CodeBuddy
 *   Read 工具的 256KB 上限);顶层图片与 **tool-result 内嵌图片**(read_image
 *   等工具的结果)一并收集;
 * - 续聊补发(`resumeReplayPrompt`):从发送锚点切片,把切换模型期间缺失的
 *   轮次完整补上,同时跳过 CodeBuddy 自己产生的消息(其会话里已有)。
 * @module subagent-codebuddy/serialize
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/** 续跑兜底:仅当没有可补发内容时使用。 */
export const CONTINUE_PROMPT = '继续完成之前未完成的任务,持续推进直到任务完全完成或遇到必须用户决策的阻塞——不要每轮只做一小步就停下汇报。基于当前工作区状态继续,不要重复已完成的工作;全部完成后给出最终结果报告。启动 dev server 等长驻进程时必须用 dsh_bash 的 run_in_background: true 参数后台运行——前台运行永不返回会卡死整个任务。';
/**
 * 工具路由说明(附在 system instructions 末尾)。
 *
 * 与 spawn 的 --tools 策略(acp.ts cliToolPolicyArgs:内置工具全禁)配套:
 * 告诉模型原生工具一律不可用、对等能力走哪套 dsh 名字。放在 system 位置
 * (权威)而不是只靠每条 prompt 尾注——CLI 内置提示词在 user 位置的指令
 * 面前占优,实测尾注拦不住模型直调原生 Bash/Edit。
 * @param bridgeMode - 工具桥接模式(决定工具名前缀)。
 * @param guidance - 读图引导:read_image 在场即原生(CodeBuddy 侧适配图片
 *   工具结果);AGY 转述仅兜底(read_image 缺席)或用户显式要求。
 * @returns 工具路由说明全文。
 */
function toolRoutingNote(bridgeMode, guidance) {
    const target = bridgeMode === 'mcp'
        ? '对等能力一律用 MCP 工具(mcp__dsh__bash、mcp__dsh__pwsh、mcp__dsh__read、mcp__dsh__read_image、mcp__dsh__edit、mcp__dsh__write、mcp__dsh__glob、mcp__dsh__grep)'
        : '对等能力一律用 dsh 前缀版本(dsh_bash、dsh_pwsh、dsh_read、dsh_read_image、dsh_edit、dsh_write、dsh_glob、dsh_grep)';
    const prefix = bridgeMode === 'mcp' ? 'mcp__dsh__' : 'dsh_';
    const imageLine = guidance === 'native'
        ? `读图片用 Read 工具直接读图片文件路径(已放行):图片会进入你的上下文并由 CodeBuddy 侧适配——不要用 ${prefix}read_image_agy 让 AGY 转述,除非用户明确要求 AGY 转述。`
        : guidance === 'agy'
            ? `读图片用 ${prefix}read_image_agy:AGY 读图后以文字描述返回(可用 prompt 指定关注点);本会话没有可用的原生读图工具。`
            : '读图片:本会话没有可用的读图工具(模型不支持图片输入且未启用 AGY 读图)——需要读图时如实告知用户。';
    return [
        '[工具路由(本环境强制)]',
        `CLI 原生工具(含 Bash/PowerShell/Read/Edit/Write/NotebookEdit/Glob/Grep)已**全部禁用**:${target}——它们在 dsh 侧执行,受审批/沙箱约束,进会话日志与后台任务面板;调用不存在的原生工具会失败,不要换别的方式绕过。${imageLine}`,
    ].join('\n');
}
/**
 * dsh system prompt 的 prompt 文本块。
 *
 * dsh 默认每个请求都带当前 system prompt(内容随工具/设置/工作区指令变化);
 * CLI 侧对话是持久历史,所以按"首次随 seed/首包发送 + 内容变化时补发"实现
 * (见 adapter 的 systemHash),重复发送时不加标题会让模型当成两条并行指令。
 * @param system - system prompt 全文。
 * @param updated - 是否是对已发过版本的更新(内容变了才为 true)。
 * @param bridgeMode - 工具桥接模式(决定工具名前缀)。
 * @param guidance - 读图引导(按当前模型是否支持图片输入分流)。
 * @returns 可直接作为 prompt 前缀的文本块。
 */
export function systemInstructionsText(system, updated = false, bridgeMode = 'delegate', guidance = 'native') {
    const header = updated
        ? 'System instructions (updated — 以本版为准,忽略早前版本):'
        : 'System instructions:';
    return `${header}\n${system}\n\n${toolRoutingNote(bridgeMode, guidance)}`;
}
/** 一条消息的可读文本(text + tool-call + tool-result 内嵌文本;图片走内容块)。 */
function messageText(message) {
    const parts = [];
    for (const block of message.content) {
        if (block.type === 'text')
            parts.push(block.text);
        else if (block.type === 'tool-call') {
            // 其他模型轮次的工具调用必须可见:不落文本的话纯工具调用的 assistant
            // 消息文本为空、整条被跳过,CLI 只见结果不见调用(实测丢失)。
            parts.push(`[tool call: ${block.name} ${block.arguments}]`);
        }
        else if (block.type === 'tool-result') {
            for (const inner of block.content) {
                if (inner.type === 'text')
                    parts.push(inner.text);
            }
        }
    }
    return parts.join('');
}
/** mediaType → 落盘扩展名。 */
const IMAGE_EXT = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
};
/** 已处理图片缓存:attachmentId → base64 + 落盘路径(进程内,内容寻址)。 */
const materializedImages = new Map();
/**
 * 收集一组消息里的图片(含 tool-result 内嵌):ACP 原生内容块(base64)+ 落盘路径。
 *
 * 为什么**同时**落盘:CLI 对"模型不支持图片"的路由会过滤 user message 与
 * `function_call_result` 里的图片(`[Image content filtered - current model
 * does not support images]`),但 **CLI 原生 Read 的图片不走该过滤**——落盘后
 * 模型可按路径用 Read 读到图片内容(Read 通道见 acp.ts 的 `--tools` 策略)。
 * 支持的模型仍直接看 ACP 图片内容块,两条通道并存。同一附件(内容寻址)
 * 只读一次、只写一次;临时目录不主动清理(系统 temp 语义)。
 */
async function collectImages(ctx, messages) {
    const attachments = ctx.get('attachments');
    const images = [];
    const paths = new Map();
    if (attachments === undefined)
        return { images, paths };
    const push = async (block) => {
        const id = String(block.attachment?.attachmentId ?? '');
        if (id.length === 0)
            return;
        const cached = materializedImages.get(id);
        if (cached !== undefined) {
            images.push({ data: cached.base64, mimeType: cached.mimeType });
            if (cached.path.length > 0)
                paths.set(id, cached.path);
            return;
        }
        try {
            const stored = await attachments.readImage(block.attachment);
            const base64 = Buffer.from(stored.data).toString('base64');
            const mimeType = stored.ref.mediaType;
            // 落盘(Read 通道):失败不影响 ACP 图片通道。
            let path = '';
            try {
                const ext = IMAGE_EXT[mimeType] ?? 'png';
                const dir = join(tmpdir(), 'dsh-codebuddy-images');
                mkdirSync(dir, { recursive: true });
                const file = join(dir, `${id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 32)}.${ext}`);
                writeFileSync(file, stored.data);
                path = file;
            }
            catch {
                // 落盘失败则只走 ACP 图片通道。
            }
            materializedImages.set(id, { base64, mimeType, path });
            images.push({ data: base64, mimeType });
            if (path.length > 0)
                paths.set(id, path);
        }
        catch {
            // 附件不可读则跳过该图。
        }
    };
    for (const message of messages) {
        for (const block of message.content) {
            if (block.type === 'image')
                await push(block);
            else if (block.type === 'tool-result') {
                for (const inner of block.content) {
                    if (inner.type === 'image')
                        await push(inner);
                }
            }
        }
    }
    return { images, paths };
}
/** 该消息内图片的落盘路径(含 tool-result 内嵌,按出现顺序去重)。 */
function imagePathsOf(message, paths) {
    const found = [];
    const push = (block) => {
        const id = String(block.attachment?.attachmentId ?? '');
        const path = id.length > 0 ? paths.get(id) : undefined;
        if (path !== undefined && !found.includes(path))
            found.push(path);
    };
    for (const block of message.content) {
        if (block.type === 'image')
            push(block);
        else if (block.type === 'tool-result') {
            for (const inner of block.content) {
                if (inner.type === 'image')
                    push(inner);
            }
        }
    }
    return found;
}
/**
 * 续聊兜底:只发**用户自己发的**最后一条消息(锚点缺失/历史被压缩收缩时)。
 *
 * 必须按 `source.kind === 'user'` 精确取:插件注入的上下文(系统提醒、
 * 工作区指令、技能目录)同样是 user 角色、且排在用户消息**之后**,
 * 按"最后一条 user 角色"取会把用户输入整条顶掉——实测:压缩完成后
 * 被 claim 的排队消息丢失,模型只看到技能目录提醒。
 *
 * 命中 skipIds(该输入已插话投递过,CLI 已见过)时返回 skippedForwarded,
 * 调用方空跑收尾,不重复发送。
 */
export async function lastUserPrompt(ctx, messages, skipIds) {
    const last = [...messages].reverse().find(message => message.role === 'user' && message.source.kind === 'user');
    if (last === undefined)
        return { prompt: CONTINUE_PROMPT, images: [] };
    if (skipIds !== undefined && skipIds.has(String(last.id))) {
        return { prompt: CONTINUE_PROMPT, images: [], skippedForwarded: true };
    }
    const text = messageText(last);
    const { images, paths } = await collectImages(ctx, [last]);
    const imagePaths = imagePathsOf(last, paths);
    const note = imagePaths.length > 0
        ? `${text.length > 0 ? '\n' : ''}[图片已保存到本地文件:${imagePaths.join(', ')}(用 Read 工具读取查看)]`
        : '';
    if (text.trim().length === 0 && images.length === 0 && note.length === 0) {
        return { prompt: CONTINUE_PROMPT, images: [] };
    }
    return { prompt: `${text}${note}`, images };
}
/**
 * 续聊补发:把"CLI 尚未见过"的消息补发给 CodeBuddy。
 *
 * 主锚是**消息 id**(`lastSentMessageId`):上次发送覆盖到的最后一条消息。
 * 数量锚(`sentCount`)在历史被压缩/编辑后不可靠——切到其他模型跑一段再切回时,
 * 数量锚越界会让补发退化成"只发最后一条",切换期间的上下文永久丢失(实测)。
 *
 * 锚点已被压缩移除 / 数量锚不可信(越界、已发区内出现压缩 checkpoint)时,
 * **不做整体重建**:CLI 侧对话是持久历史(它有完整上下文,压缩只发生在
 * dsh 视角)——重发 CLI 已知内容会膨胀上下文,且会被当作新任务从头重跑
 * (实测)。只发最后一条用户输入兜底,保证最新指令必达。
 *
 * 补发按 User/Assistant 序列化;CodeBuddy 自己产生的消息(assistant/tool)与
 * 已中途转发的插入消息(`skipIds`)跳过。
 * @param ctx - 插件上下文(读取附件服务)。
 * @param messages - 当前 dsh 折叠视图的完整消息序列。
 * @param sentCount - 旧的数量锚(仅兼容历史记录;新锚见下)。
 * @param skipIds - 已在生成中转发过的插入消息 id 集合(可选)。
 * @param lastSentMessageId - 上次发送覆盖到的最后一条消息 id(主锚,可选)。
 * @returns 序列化结果(prompt + 原生图片块)。
 */
export async function resumeReplayPrompt(ctx, messages, sentCount, skipIds, lastSentMessageId, ownProvider = 'codebuddy') {
    if (lastSentMessageId !== undefined && lastSentMessageId.length > 0) {
        const at = messages.findIndex(message => String(message.id) === lastSentMessageId);
        if (at >= 0)
            return await replayFrom(ctx, messages, at + 1, skipIds, ownProvider);
        // 锚点已被压缩移除:定位不到"CLI 尚未见过"的边界,只发最后一条
        // 用户输入兜底(CLI 有自己的完整上下文,见上)。
        return await lastUserPrompt(ctx, messages, skipIds);
    }
    if (sentCount === undefined)
        return await lastUserPrompt(ctx, messages, skipIds);
    // 数量锚在两种历史收缩下不可信,都不按它切片:
    // - 越界(大幅压缩):索引必然错位;
    // - 前 sentCount 条里出现压缩 checkpoint(遮蔽段落在已发区内的小幅压缩):
    //   折叠把后续消息拉进"已发"区,未发送的消息会被数量锚静默吞掉。
    if (sentCount > messages.length || hasCompactionCheckpoint(messages, sentCount)) {
        return await lastUserPrompt(ctx, messages, skipIds);
    }
    return await replayFrom(ctx, messages, sentCount, skipIds, ownProvider);
}
/**
 * 前 limit 条里是否有压缩 checkpoint(dsh 原生与镜像压缩的 replace 消息,
 * source 同形:`{ kind:'plugin', plugin:'compact' }`)。数量锚遇到它即不可信。
 */
function hasCompactionCheckpoint(messages, limit) {
    for (let index = 0; index < Math.min(limit, messages.length); index += 1) {
        const source = messages[index].source;
        if (source?.kind === 'plugin' && source.plugin === 'compact')
            return true;
    }
    return false;
}
/**
 * 从 start 起补发:对**整个尾段**逐条过滤,而不是只找第一个新消息。
 *
 * 跳过(它们的接收方 CLI 已有):CodeBuddy 自己的 assistant 回答及其跟随的
 * 工具结果(含 start 之后的——切换其他模型再切回时,期间穿插的 own 轮同样
 * 已在 CLI 历史里,重发只会膨胀上下文)、已中途转发的插入消息(`skipIds`)。
 *
 * 跟踪"当前这一轮是谁跑的"贯穿全序列:其他模型的回答/工具结果必须补发,
 * 否则切回后模型看不到那段上下文(实测:补发把 assistant 一律当"自己的"
 * 跳过,期间内容全丢)。
 */
async function replayFrom(ctx, messages, start, skipIds, ownProvider) {
    let skippedForwarded = false;
    let ownTurn = true;
    const selected = [];
    for (let index = start; index < messages.length; index += 1) {
        const message = messages[index];
        if (skipIds !== undefined && skipIds.has(String(message.id))) {
            skippedForwarded = true;
            continue;
        }
        if (message.role === 'assistant') {
            const source = message.source;
            ownTurn = source?.kind === 'model' && source.provider === ownProvider;
            if (ownTurn)
                continue;
        }
        else if (message.source.kind === 'tool' && ownTurn) {
            continue;
        }
        selected.push(message);
    }
    // 全部跳过:没有可补发的新内容。若跳过的是**我们已插话投递过的**消息,
    // 说明这一步只是 dsh 在回合边界把那条插话 claim 成了新 step——模型在运行中
    // 已经处理过它。此时绝不能再发"继续完成之前未完成的任务":实测这句会把模型
    // 从插话上拽回旧任务(用户视角:插队没生效)。调用方据 skippedForwarded 空跑收尾。
    if (selected.length === 0) {
        return { prompt: CONTINUE_PROMPT, images: [], skippedForwarded };
    }
    return await serializeParts(ctx, [], selected);
}
/** 把 harness 消息序列化为 CodeBuddy 单轮 prompt;图片走原生内容块。 */
export async function buildPrompt(ctx, options) {
    const prefix = [];
    if (options.system !== undefined && options.system.length > 0) {
        prefix.push(`System instructions:\n${options.system}`);
    }
    return serializeParts(ctx, prefix, options.messages);
}
/** 序列化主体:前缀(系统提示)+ 消息文本;图片收集为原生内容块 + 落盘路径。 */
async function serializeParts(ctx, parts, messages) {
    const { images, paths } = await collectImages(ctx, messages);
    for (const message of messages) {
        const text = messageText(message);
        const imagePaths = imagePathsOf(message, paths);
        const note = imagePaths.length > 0
            ? `${text.length > 0 ? '\n' : ''}[图片已保存到本地文件:${imagePaths.join(', ')}(用 Read 工具读取查看)]`
            : '';
        if (text.length === 0 && note.length === 0)
            continue;
        const label = message.role === 'assistant' ? 'Assistant' : 'User';
        parts.push(`${label}: ${text}${note}`);
    }
    return { prompt: parts.join('\n\n'), images };
}
