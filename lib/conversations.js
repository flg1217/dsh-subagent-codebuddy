/**
 * 会话续接映射的持久化:dsh 会话 id → CodeBuddy ACP sessionId + 发送锚点。
 *
 * 服务重启后凭此恢复 CodeBuddy 侧的持久对话(session/load 续聊),而不是
 * 每次当作新会话从头灌历史。`sentCount` 记录上次发送 prompt 时 dsh 消息数,
 * 作为"补发缺失轮次"的切片锚点。
 * @module subagent-codebuddy/conversations
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
/** 映射上限(超出按最久未使用逐出)。 */
const MAX_CONVERSATIONS = 2048;
/** 落盘防抖。 */
const SAVE_DEBOUNCE_MS = 500;
/** 默认存储文件:`~/.dsh/codebuddy/conversations.json`。 */
function defaultFile() {
    return join(homedir(), '.dsh', 'codebuddy', 'conversations.json');
}
/** 持久化的续接映射(纯内存模式用于测试:file = null)。 */
export class ConversationStore {
    file;
    map = new Map();
    saveTimer;
    /**
     * @param file - 存储文件路径;`null` 为纯内存(测试用)。
     */
    constructor(file = defaultFile()) {
        this.file = file;
        this.load();
    }
    /** 读取会话的续接记录。 */
    get(sessionId) {
        return this.map.get(sessionId);
    }
    /** 写入/更新续接记录(自动落盘)。 */
    set(sessionId, record) {
        this.map.set(sessionId, { ...record, at: Date.now() });
        while (this.map.size > MAX_CONVERSATIONS) {
            let oldestKey;
            let oldestAt = Number.POSITIVE_INFINITY;
            for (const [key, value] of this.map) {
                if (value.at < oldestAt) {
                    oldestAt = value.at;
                    oldestKey = key;
                }
            }
            if (oldestKey === undefined)
                break;
            this.map.delete(oldestKey);
        }
        this.scheduleSave();
    }
    /** 删除会话记录(如 CodeBuddy 侧会话丢失时)。 */
    delete(sessionId) {
        if (this.map.delete(sessionId))
            this.scheduleSave();
    }
    load() {
        if (this.file === null)
            return;
        try {
            const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
            for (const [key, value] of Object.entries(parsed)) {
                if (typeof value?.acpId !== 'string')
                    continue;
                this.map.set(key, {
                    acpId: value.acpId,
                    sentCount: Number.isSafeInteger(value.sentCount) ? value.sentCount : 0,
                    at: Number.isSafeInteger(value.at) ? value.at : 0,
                });
            }
        }
        catch {
            // 文件不存在或损坏:从空开始(下次变更重建)。
        }
    }
    scheduleSave() {
        if (this.file === null || this.saveTimer !== undefined)
            return;
        this.saveTimer = setTimeout(() => {
            this.saveTimer = undefined;
            this.saveNow();
        }, SAVE_DEBOUNCE_MS);
        this.saveTimer.unref?.();
    }
    saveNow() {
        if (this.file === null)
            return;
        try {
            mkdirSync(dirname(this.file), { recursive: true });
            const tmp = `${this.file}.tmp`;
            writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.map), null, 2));
            renameSync(tmp, this.file);
        }
        catch {
            // 写失败不致命:映射仍在内存,下次变更再试。
        }
    }
}
