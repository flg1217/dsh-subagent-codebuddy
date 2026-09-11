/**
 * dsh 中途插入(`agent/inbox/spliced`)折叠。
 *
 * dsh 允许生成过程中插入新的用户消息:消息先进 per-target 的 inbox
 * (splice 事件落会话日志,`inserted` 插入到 `start`),在下一个 step/turn
 * 边界被 claim 后才成为 `user/message`。codebuddy 轮是单个长 step,插入
 * 会一直悬挂——本模块折叠出**尚未被 claim 的用户消息**,供适配器识别插话:
 * `next-step`(插话/立即发送)走 ACP `session/steer` 立即注入运行中的回合;
 * `next-turn`(排队)不在生成中转发,由 dsh 在回合收尾 claim 成下一轮输入。
 *
 * 队列按 target 分开维护;非 user 来源(插件注入的 context 等)保留在队列里
 * 参与位置对齐,但不出现在结果中。
 * @module subagent-codebuddy/inbox
 */
/** 一条悬挂待领的用户插入。 */
export interface PendingInsertion {
    /** 消息 id(与后续 user/message 事件同 id,用于去重)。 */
    id: string;
    /** 文本内容。 */
    text: string;
    /**
     * 是否插话(`next-step` 队列):插话应立即投递给运行中的 CodeBuddy
     * (ACP `session/steer`);`next-turn` 只排队,等当前工作结束。
     */
    steer: boolean;
}
/**
 * 折叠会话事件里的 inbox splice,得到尚未 claim 的用户消息。
 * @param events - 会话自身事件(ownEvents)。
 * @returns 悬挂的用户插入(按事件顺序;同 id 只出现一次)。
 */
export declare function foldPendingInsertions(events: readonly {
    type: string;
    data?: unknown;
}[]): PendingInsertion[];
