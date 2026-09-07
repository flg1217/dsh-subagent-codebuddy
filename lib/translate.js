/**
 * CodeBuddy print 模式 stream-json 翻译器。
 *
 * CodeBuddy `-p --output-format stream-json` 按行输出完整事件,事件类型:
 * - `system`(init/status):会话初始化信息,忽略;
 * - `file-history-snapshot`:文件快照,忽略;
 * - `assistant`:完整 assistant 消息,content 块含
 *   `thinking` / `text` / `tool_use`(name,id,input);
 * - `user`:工具结果消息,content 块含 `tool_result`(tool_use_id,is_error,content);
 * - `result`:最终结果(subtype success/error,is_error,usage,permission_denials)。
 *
 * 翻译策略(对齐 llm-agy/translate.ts):
 * - thinking → reasoning 块(非空时);
 * - text → text 块(block-start/text-delta/block-end);
 * - tool_use → 会话 tool/call 事件(由调用方 append);
 * - user 行 → 会话 tool/result 事件;
 * - result.is_error → 携带执行反馈文本 + error finish。
 * @module subagent-codebuddy/translate
 */
/** CodeBuddy usage → dsh TokenUsage。 */
function mapCodebuddyUsage(usage) {
    if (usage === undefined)
        return undefined;
    const input = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
    const output = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;
    const cacheRead = typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0;
    return {
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        reasoningTokens: 0,
    };
}
export class CodebuddyTranslator {
    nextIndex = 0;
    _resultError;
    _usage;
    recent = [];
    /** 已收到的执行错误(CodeBuddy result.is_error)。 */
    get resultError() {
        return this._resultError;
    }
    /** 最近执行步骤(前 8 步,异常反馈用)。 */
    get recentSteps() {
        return this.recent;
    }
    pushText(text) {
        const index = this.nextIndex++;
        return [
            { type: 'block-start', index, blockType: 'text' },
            { type: 'text-delta', index, text },
            { type: 'block-end', index, block: { type: 'text', text } },
        ];
    }
    pushReasoning(text) {
        const index = this.nextIndex++;
        return [
            { type: 'block-start', index, blockType: 'reasoning' },
            { type: 'text-delta', index, text },
            { type: 'block-end', index, block: { type: 'reasoning', text } },
        ];
    }
    /** 逐行处理 stream-json;调用方逐行 push,流结束后调用 end() 收尾。 */
    push(line) {
        const chunks = [];
        const toolSteps = [];
        let parsed;
        try {
            parsed = JSON.parse(line);
        }
        catch {
            // 非 JSON 行(日志等)直接忽略。
            return { chunks, toolSteps };
        }
        if (parsed.type === 'assistant') {
            const message = (parsed.message ?? {});
            const content = Array.isArray(message.content) ? message.content : [];
            for (const block of content) {
                switch (block.type) {
                    case 'thinking': {
                        // CLI 的 thinking 块字段名是 `thinking`(实测 stream-json:
                        // {type:'thinking', thinking:'...', signature}),不是 text;
                        // 之前读 block.text 永远为空,reasoning 块从未产出,子代理
                        // 窗口因此只剩一排工具调用卡。
                        const text = typeof block.thinking === 'string'
                            ? block.thinking
                            : typeof block.text === 'string' ? block.text : '';
                        if (text.length > 0)
                            chunks.push(...this.pushReasoning(text));
                        break;
                    }
                    case 'text': {
                        const text = typeof block.text === 'string' ? block.text : '';
                        if (text.length > 0)
                            chunks.push(...this.pushText(text));
                        break;
                    }
                    case 'tool_use': {
                        const callId = typeof block.id === 'string' ? block.id : undefined;
                        const name = typeof block.name === 'string' ? block.name : undefined;
                        if (callId !== undefined && name !== undefined) {
                            const argumentsJson = block.input === undefined ? undefined : JSON.stringify(block.input);
                            toolSteps.push({
                                kind: 'tool/call',
                                callId,
                                name,
                                argumentsJson,
                            });
                            this.recent.push({
                                callId,
                                toolName: name,
                                args: argumentsJson ?? '',
                                status: 'running',
                            });
                            if (this.recent.length > 8)
                                this.recent.splice(0, this.recent.length - 8);
                        }
                        break;
                    }
                    default:
                        break;
                }
            }
        }
        else if (parsed.type === 'user') {
            const message = (parsed.message ?? {});
            const content = Array.isArray(message.content) ? message.content : [];
            for (const block of content) {
                if (block.type !== 'tool_result')
                    continue;
                const callId = typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined;
                if (callId === undefined)
                    continue;
                const isError = block.is_error === true;
                // content 是内容块数组(部分版本为 JSON 字符串化的数组),取其文本片段。
                let outputText = '';
                const raw = block.content;
                const extractText = (blocks) => blocks
                    .filter((b) => typeof b === 'object' && b !== null && b.type === 'text'
                    && typeof b.text === 'string')
                    .map(b => b.text)
                    .join('\n');
                if (Array.isArray(raw)) {
                    outputText = extractText(raw);
                }
                else if (typeof raw === 'string') {
                    try {
                        const parsedContent = JSON.parse(raw);
                        if (Array.isArray(parsedContent)) {
                            outputText = extractText(parsedContent);
                        }
                        else if (typeof parsedContent === 'string') {
                            outputText = parsedContent;
                        }
                    }
                    catch {
                        outputText = raw;
                    }
                }
                toolSteps.push({
                    kind: 'tool/result',
                    callId,
                    outputText: outputText.slice(0, 2000),
                    isError,
                });
                const last = this.recent.find(s => s.callId === callId && s.status === 'running');
                if (last !== undefined) {
                    last.status = isError ? 'FAILED' : 'OK';
                    if (isError)
                        last.message = outputText.split('\n')[0]?.slice(0, 200) ?? 'unknown error';
                }
            }
        }
        else if (parsed.type === 'result') {
            if (parsed.is_error === true) {
                const message = typeof parsed.result === 'string' ? parsed.result : JSON.stringify(parsed.result ?? '');
                this._resultError = message.slice(0, 1000);
                chunks.push(...this.pushText(`**CodeBuddy 执行失败**:${message.slice(0, 500)}`));
            }
            const usage = mapCodebuddyUsage((parsed.usage ?? {}));
            if (usage !== undefined) {
                this._usage = {
                    inputTokens: (this._usage?.inputTokens ?? 0) + usage.inputTokens,
                    outputTokens: (this._usage?.outputTokens ?? 0) + usage.outputTokens,
                    cacheReadTokens: Math.max(this._usage?.cacheReadTokens ?? 0, usage.cacheReadTokens ?? 0),
                    reasoningTokens: (this._usage?.reasoningTokens ?? 0) + (usage.reasoningTokens ?? 0),
                };
            }
        }
        return { chunks, toolSteps };
    }
    /** 流结束:产出 usage + finish。 */
    end() {
        const chunks = [];
        if (this._usage !== undefined) {
            chunks.push({ type: 'usage', usage: this._usage });
        }
        if (this._resultError !== undefined) {
            chunks.push({
                type: 'finish',
                reason: {
                    kind: 'error',
                    failure: { message: `codebuddy 执行失败: ${this._resultError}`, code: 'CODEBUDDY_EXEC_ERROR' },
                },
            });
        }
        else {
            chunks.push({ type: 'finish', reason: { kind: 'stop' } });
        }
        return chunks;
    }
}
