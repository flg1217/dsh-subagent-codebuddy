/**
 * 会话续接映射的持久化:dsh 会话 id → CodeBuddy ACP sessionId + 发送锚点。
 *
 * 服务重启后凭此恢复 CodeBuddy 侧的持久对话(session/load 续聊),而不是
 * 每次当作新会话从头灌历史。`sentCount` 记录上次发送 prompt 时 dsh 消息数,
 * 作为"补发缺失轮次"的切片锚点。
 * @module subagent-codebuddy/conversations
 */
/** 一条续接记录。 */
export interface ConversationRecord {
    /** CodeBuddy 侧 ACP sessionId。 */
    acpId: string;
    /** 上次发送 prompt 时 dsh 消息总数(缺失轮次补发的锚点)。 */
    sentCount: number;
    /** 最后使用时间(逐出排序用)。 */
    at: number;
}
/** 持久化的续接映射(纯内存模式用于测试:file = null)。 */
export declare class ConversationStore {
    private readonly file;
    private readonly map;
    private saveTimer;
    /**
     * @param file - 存储文件路径;`null` 为纯内存(测试用)。
     */
    constructor(file?: string | null);
    /** 读取会话的续接记录。 */
    get(sessionId: string): ConversationRecord | undefined;
    /** 写入/更新续接记录(自动落盘)。 */
    set(sessionId: string, record: {
        acpId: string;
        sentCount: number;
    }): void;
    /** 删除会话记录(如 CodeBuddy 侧会话丢失时)。 */
    delete(sessionId: string): void;
    private load;
    private scheduleSave;
    private saveNow;
}
