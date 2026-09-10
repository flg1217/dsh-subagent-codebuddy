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
/** 工具名归一(小写并去掉分隔符:TaskCreate/task_create/todo_write → taskcreate/todowrite)。 */
function normalized(name) {
    return name.toLowerCase().replace(/[_-]/g, '');
}
/** 归一后的工具类别(适配器/镜像共用分支判断)。 */
export function todoToolKind(name) {
    const key = normalized(name);
    return key === 'todowrite' || key === 'taskcreate' || key === 'taskupdate' ? key : undefined;
}
/** CodeBuddy 状态 → dsh 三态;未知按 pending。 */
function normalizeStatus(value) {
    if (value === 'completed' || value === 'done')
        return 'completed';
    if (value === 'in_progress' || value === 'in-progress' || value === 'running')
        return 'in_progress';
    if (value === 'deleted' || value === 'cancelled' || value === 'canceled' || value === 'removed')
        return 'deleted';
    return 'pending';
}
/**
 * 一个会话的 todo 列表状态(整表快照 + taskId 绑定)。
 * 变化时返回 true,由调用方决定何时落地 `todo/write`。
 */
export class TodoListState {
    list = [];
    idIndex = new Map();
    /**
     * 待结果确认的 TaskUpdate(callId → 意图)。
     * CodeBuddy 的任务存储可能失效(实测:启动团队子代理后被重置,更新返回
     * "Task with ID ... not found"),只有**成功结果**才折算进 dsh 的整表。
     */
    pendingUpdates = new Map();
    /** 从会话已提交事件播种(折叠最新一条 todo/write,支持进程内跨轮复用)。 */
    seed(events) {
        for (const event of events) {
            if (event.type !== 'todo/write')
                continue;
            const todos = event.data?.todos;
            if (Array.isArray(todos))
                this.list = this.sanitize(todos);
            this.idIndex.clear(); // 播种后丢失 id 绑定:后续 TaskUpdate 按 content 兜底匹配
        }
    }
    /** 当前整表快照。 */
    snapshot() {
        return this.list.map(item => ({ ...item }));
    }
    /**
     * 应用一次工具调用(增量语义折算为整表)。
     * TaskUpdate 只登记意图,待 {@link resolveTaskUpdate} 按结果确认后折算。
     * @returns 列表是否变化(需要落地 todo/write)。
     */
    applyToolCall(name, args) {
        switch (normalized(name)) {
            case 'todowrite': {
                if (!Array.isArray(args['todos']))
                    return false;
                this.list = this.sanitize(args['todos']);
                this.idIndex.clear();
                return true;
            }
            case 'taskcreate': {
                const content = String(args['subject'] ?? args['content'] ?? args['description'] ?? '(untitled task)');
                this.list = [...this.list, { content, status: 'pending' }];
                return true;
            }
            case 'taskupdate': {
                const id = args['taskId'] === undefined ? undefined : String(args['taskId']);
                return this.applyTaskUpdate(id, normalizeStatus(args['status']));
            }
            default:
                return false;
        }
    }
    /** 登记一条 TaskUpdate 意图(callId 维度),等结果确认。 */
    deferTaskUpdate(callId, args) {
        this.pendingUpdates.set(callId, {
            ...(args['taskId'] === undefined ? {} : { taskId: String(args['taskId']) }),
            status: normalizeStatus(args['status']),
        });
    }
    /**
     * 按工具结果确认并折算一条 TaskUpdate。
     * @param callId - 之前 defer 的调用 id。
     * @param resultText - 工具结果文本(只有 Updated task 视为成功)。
     * @returns 列表是否变化(需要落地 todo/write)。
     */
    resolveTaskUpdate(callId, resultText) {
        const intent = this.pendingUpdates.get(callId);
        if (intent === undefined)
            return false;
        this.pendingUpdates.delete(callId);
        if (!/updated\s+task/i.test(resultText))
            return false; // not found / 报错:不同步
        return this.applyTaskUpdate(intent.taskId, intent.status);
    }
    /** 按 id 改状态(deleted 移除并重排绑定)。 */
    applyTaskUpdate(id, status) {
        let index = id === undefined ? undefined : this.idIndex.get(id);
        if (index === undefined && id !== undefined) {
            // 未绑定(如重启后)按 content 兜底:仅当只有一个未绑定条目时。
            const unbound = this.list.length === 1 ? 0 : undefined;
            index = unbound;
            if (index !== undefined)
                this.idIndex.set(id, index);
        }
        if (index === undefined || index >= this.list.length)
            return false;
        if (status === 'deleted') {
            this.list = this.list.filter((_, i) => i !== index);
            this.idIndex.delete(id);
            // 重排后续绑定
            for (const [key, value] of [...this.idIndex]) {
                if (value > index)
                    this.idIndex.set(key, value - 1);
            }
        }
        else {
            this.list = this.list.map((item, i) => (i === index ? { ...item, status } : item));
        }
        return true;
    }
    /**
     * 应用工具结果:从 TaskCreate 的结果文本解析任务 id 并绑定到刚追加的条目。
     * @param name - 工具名。
     * @param text - 结果文本。
     */
    applyToolResult(name, text) {
        if (normalized(name) !== 'taskcreate')
            return;
        const id = /Task #([^\s]+) created/i.exec(text)?.[1];
        if (id === undefined)
            return;
        // 最后一个尚未绑定的条目即本次创建。
        for (let i = this.list.length - 1; i >= 0; i--) {
            const bound = [...this.idIndex.values()].includes(i);
            if (!bound) {
                this.idIndex.set(id, i);
                return;
            }
        }
    }
    /** 外部快照清洗(todo_write 的 todos 数组 → 规范条目)。 */
    sanitize(todos) {
        const items = [];
        for (const entry of todos) {
            if (typeof entry !== 'object' || entry === null)
                continue;
            const record = entry;
            const content = String(record['content'] ?? record['subject'] ?? '');
            if (content.length === 0)
                continue;
            const status = normalizeStatus(record['status']);
            items.push({ content, status: status === 'deleted' ? 'completed' : status });
        }
        return items;
    }
}
