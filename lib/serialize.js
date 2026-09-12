/**
 * 序列化模块:把 dsh 消息翻译为 CodeBuddy 单轮 prompt。
 * - 系统提示(可选)、对话消息按顺序拼接为文本;
 * - 图片块读字节后以 **ACP 原生 image 内容块**(base64)随 prompt 发送
 *   (`promptCapabilities.image` 实测支持,不再落盘走路径——避开 CodeBuddy
 *   Read 工具的 256KB 上限);
 * - 续聊补发(`resumeReplayPrompt`):从发送锚点切片,把切换模型期间缺失的
 *   轮次完整补上,同时跳过 CodeBuddy 自己产生的消息(其会话里已有)。
 * @module subagent-codebuddy/serialize
 */
/** 续跑兜底:仅当没有可补发内容时使用。 */
export const CONTINUE_PROMPT = '继续完成之前未完成的任务,持续推进直到任务完全完成或遇到必须用户决策的阻塞——不要每轮只做一小步就停下汇报。基于当前工作区状态继续,不要重复已完成的工作;全部完成后给出最终结果报告。启动 dev server 等长驻进程时必须用 Bash 的 run_in_background: true 参数后台运行——前台运行永不返回会卡死整个任务。';
/** 一条消息的可读文本(text 块 + tool-result 内嵌文本;图片走内容块)。 */
function messageText(message) {
    const parts = [];
    for (const block of message.content) {
        if (block.type === 'text')
            parts.push(block.text);
        else if (block.type === 'tool-result') {
            for (const inner of block.content) {
                if (inner.type === 'text')
                    parts.push(inner.text);
            }
        }
    }
    return parts.join('');
}
/** 读取一组消息里的图片块(失败跳过),返回 ACP 原生内容块数据。 */
async function readImages(ctx, messages) {
    const attachments = ctx.get('attachments');
    if (attachments === undefined)
        return [];
    const images = [];
    for (const message of messages) {
        for (const block of message.content) {
            if (block.type !== 'image')
                continue;
            try {
                const stored = await attachments.readImage(block.attachment);
                images.push({
                    data: Buffer.from(stored.data).toString('base64'),
                    mimeType: stored.ref.mediaType,
                });
            }
            catch {
                // 附件不可读则跳过该图。
            }
        }
    }
    return images;
}
/**
 * 续聊兜底:只发**用户自己发的**最后一条消息(锚点缺失/历史被压缩收缩时)。
 *
 * 必须按 `source.kind === 'user'` 精确取:插件注入的上下文(系统提醒、
 * 工作区指令、技能目录)同样是 user 角色、且排在用户消息**之后**,
 * 按"最后一条 user 角色"取会把用户输入整条顶掉——实测:压缩完成后
 * 被 claim 的排队消息丢失,模型只看到技能目录提醒。
 */
export async function lastUserPrompt(ctx, messages) {
    const last = [...messages].reverse().find(message => message.role === 'user' && message.source.kind === 'user');
    if (last === undefined)
        return { prompt: CONTINUE_PROMPT, images: [] };
    const text = messageText(last);
    const images = await readImages(ctx, [last]);
    if (text.trim().length === 0 && images.length === 0)
        return { prompt: CONTINUE_PROMPT, images: [] };
    return { prompt: text, images };
}
/**
 * 续聊补发:把"CLI 尚未见过"的消息补发给 CodeBuddy。
 *
 * 主锚是**消息 id**(`lastSentMessageId`):上次发送覆盖到的最后一条消息。
 * 数量锚(`sentCount`)在历史被压缩/编辑后不可靠——切到其他模型跑一段再切回时,
 * 数量锚越界会让补发退化成"只发最后一条",切换期间的上下文永久丢失(实测)。
 * 锚点已被压缩移除时,CLI 缺的就是"当前 surface 全部",整体序列化重建。
 *
 * 补发按 User/Assistant 序列化;CodeBuddy 自己产生的消息(assistant/tool)与
 * 已中途转发的插入消息(`skipIds`)跳过。
 * @param ctx - 插件上下文(读取附件服务)。
 * @param messages - 当前 dsh 折叠视图的完整消息序列。
 * @param sentCount - 旧的数量锚(仅兼容历史记录;新锚见下)。
 * @param skipIds - 已在生成中转发过的插入消息 id 集合(可选)。
 * @param lastSentMessageId - 上次发送覆盖到的最后一条消息 id(主锚,可选)。
 * @returns 序列化结果(prompt + 原生图片块 + 本次覆盖到的最后消息 id)。
 */
export async function resumeReplayPrompt(ctx, messages, sentCount, skipIds, lastSentMessageId, ownProvider = 'codebuddy') {
    const latestId = () => (messages.length === 0 ? undefined : String(messages[messages.length - 1].id));
    if (lastSentMessageId !== undefined && lastSentMessageId.length > 0) {
        const at = messages.findIndex(message => String(message.id) === lastSentMessageId);
        if (at >= 0)
            return await replayFrom(ctx, messages, at + 1, skipIds, latestId(), ownProvider);
        // 锚点已被压缩移除:CLI 缺的是当前 surface 全部——整体重建(压缩后的
        // surface 已是精简视图,尺寸可控)。
        if (messages.length === 0)
            return { prompt: CONTINUE_PROMPT, images: [] };
        const rebuilt = await serializeMessages(ctx, messages);
        const id = latestId();
        return { ...rebuilt, ...(id === undefined ? {} : { lastMessageId: id }) };
    }
    if (sentCount === undefined)
        return await lastUserPrompt(ctx, messages);
    if (sentCount > messages.length) {
        // 旧数量锚越界(历史被压缩收缩):整体重建,不再退化成"只发最后一条"。
        if (messages.length === 0)
            return { prompt: CONTINUE_PROMPT, images: [] };
        const rebuilt = await serializeMessages(ctx, messages);
        const id = latestId();
        return { ...rebuilt, ...(id === undefined ? {} : { lastMessageId: id }) };
    }
    return await replayFrom(ctx, messages, sentCount, skipIds, latestId(), ownProvider);
}
/** 从 start 起补发(跳过 CodeBuddy 自己的 assistant/tool 与已转发),带回覆盖到的最后消息 id。 */
async function replayFrom(ctx, messages, start, skipIds, lastMessageId, ownProvider) {
    let index = start;
    let skippedForwarded = false;
    // 跟踪"当前这一轮是谁跑的":CodeBuddy 自己的回答(及其跟随的工具结果)CLI
    // 已有;**切换其他模型期间**产生的回答/工具结果必须补发——否则切回后模型
    // 看不到那段上下文(实测:补发把 assistant 一律当"自己的"跳过,期间内容全丢)。
    let ownTurn = true;
    while (index < messages.length) {
        const message = messages[index];
        const forwarded = skipIds !== undefined && skipIds.has(String(message.id));
        if (message.role === 'assistant') {
            const source = message.source;
            ownTurn = source?.kind === 'model' && source.provider === ownProvider;
            if (ownTurn || forwarded) {
                if (forwarded)
                    skippedForwarded = true;
                index += 1;
                continue;
            }
            break;
        }
        if (message.source.kind === 'tool') {
            if (ownTurn || forwarded) {
                if (forwarded)
                    skippedForwarded = true;
                index += 1;
                continue;
            }
            break;
        }
        if (forwarded) {
            skippedForwarded = true;
            index += 1;
            continue;
        }
        break;
    }
    // 全部跳过:没有可补发的新内容。若跳过的是**我们已插话投递过的**消息,
    // 说明这一步只是 dsh 在回合边界把那条插话 claim 成了新 step——模型在运行中
    // 已经处理过它。此时绝不能再发"继续完成之前未完成的任务":实测这句会把模型
    // 从插话上拽回旧任务(用户视角:插队没生效)。调用方据 skippedForwarded 空跑收尾。
    if (index >= messages.length) {
        return {
            prompt: CONTINUE_PROMPT,
            images: [],
            skippedForwarded,
            ...(lastMessageId === undefined ? {} : { lastMessageId }),
        };
    }
    const serialized = await serializeMessages(ctx, messages.slice(index));
    return { ...serialized, ...(lastMessageId === undefined ? {} : { lastMessageId }) };
}
/** 把一组消息序列化为 prompt(无系统提示);图片走原生内容块。 */
export async function serializeMessages(ctx, messages) {
    return serializeParts(ctx, [], messages);
}
/** 把 harness 消息序列化为 CodeBuddy 单轮 prompt;图片走原生内容块。 */
export async function buildPrompt(ctx, options) {
    const prefix = [];
    if (options.system !== undefined && options.system.length > 0) {
        prefix.push(`System instructions:\n${options.system}`);
    }
    return serializeParts(ctx, prefix, options.messages);
}
/** 序列化主体:前缀(系统提示)+ 消息文本;图片收集为原生内容块。 */
async function serializeParts(ctx, parts, messages) {
    for (const message of messages) {
        const text = messageText(message);
        if (text.length === 0)
            continue;
        const label = message.role === 'assistant' ? 'Assistant' : 'User';
        parts.push(`${label}: ${text}`);
    }
    return { prompt: parts.join('\n\n'), images: await readImages(ctx, messages) };
}
