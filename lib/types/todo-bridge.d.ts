/**
 * CodeBuddy 任务/todo 工具 → dsh `todo/write` 事件桥接。
 *
 * dsh 的 todo 是**整表快照**语义(`{todos:[{content,status}]}` 最新胜,UI 有
 * TodoPanel 渲染);CodeBuddy 侧是增量工具族:
 * - `todo_write{todos}`:与 dsh 同构,直接替换;
 * - `TaskCreate{subject,description,activeForm}`:追加一条 pending,
 *   任务 id 从结果文本 `Task #N created successfully: ...` 解析绑定;
 * - `TaskUpdate{taskId,status}`:按 id 改状态(deleted 移除)。
 *
 * 桥接器维护列表状态,每次变化输出整表快照供 `session.append('todo/write')`。
 * @module subagent-codebuddy/todo-bridge
 */
/** dsh todo 条目(与 tool-todo 的 TodoItem 同构)。 */
export interface TodoItem {
    content: string;
    status: 'pending' | 'in_progress' | 'completed';
}
/** 归一后的工具类别(适配器/镜像共用分支判断)。 */
export declare function todoToolKind(name: string): 'todowrite' | 'taskcreate' | 'taskupdate' | undefined;
/**
 * 一个会话的 todo 列表状态(整表快照 + taskId 绑定)。
 * 变化时返回 true,由调用方决定何时落地 `todo/write`。
 */
export declare class TodoListState {
    private list;
    private readonly idIndex;
    /**
     * 待结果确认的 TaskUpdate(callId → 意图)。
     * CodeBuddy 的任务存储可能失效(实测:启动团队子代理后被重置,更新返回
     * "Task with ID ... not found"),只有**成功结果**才折算进 dsh 的整表。
     */
    private readonly pendingUpdates;
    /** 从会话已提交事件播种(折叠最新一条 todo/write,支持进程内跨轮复用)。 */
    seed(events: readonly {
        type: string;
        data?: unknown;
    }[]): void;
    /** 当前整表快照。 */
    snapshot(): TodoItem[];
    /**
     * 应用一次工具调用(增量语义折算为整表)。
     * TaskUpdate 只登记意图,待 {@link resolveTaskUpdate} 按结果确认后折算。
     * @returns 列表是否变化(需要落地 todo/write)。
     */
    applyToolCall(name: string, args: Record<string, unknown>): boolean;
    /** 登记一条 TaskUpdate 意图(callId 维度),等结果确认。 */
    deferTaskUpdate(callId: string, args: Record<string, unknown>): void;
    /**
     * 按工具结果确认并折算一条 TaskUpdate。
     * @param callId - 之前 defer 的调用 id。
     * @param resultText - 工具结果文本(只有 Updated task 视为成功)。
     * @returns 列表是否变化(需要落地 todo/write)。
     */
    resolveTaskUpdate(callId: string, resultText: string): boolean;
    /** 按 id 改状态(deleted 移除并重排绑定)。 */
    private applyTaskUpdate;
    /**
     * 应用工具结果:从 TaskCreate 的结果文本解析任务 id 并绑定到刚追加的条目。
     * @param name - 工具名。
     * @param text - 结果文本。
     */
    applyToolResult(name: string, text: string): void;
    /** 外部快照清洗(todo_write 的 todos 数组 → 规范条目)。 */
    private sanitize;
}
