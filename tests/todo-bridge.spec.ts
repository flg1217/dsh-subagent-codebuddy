/**
 * TodoListState 测试:CodeBuddy 任务工具(增量)折算 dsh todo/write(整表)。
 * TaskUpdate 走 defer → resolve(仅成功结果折算,CodeBuddy 拒绝时不同步)。
 */
import { describe, expect, it } from 'vitest'
import { todoToolKind, TodoListState } from '../src/todo-bridge.ts'

describe('TodoListState', () => {
  it('todoToolKind 归一(TaskCreate/task_create/todo_write)', () => {
    expect(todoToolKind('TaskCreate')).toBe('taskcreate')
    expect(todoToolKind('task_create')).toBe('taskcreate')
    expect(todoToolKind('TaskUpdate')).toBe('taskupdate')
    expect(todoToolKind('task_update')).toBe('taskupdate')
    expect(todoToolKind('todo_write')).toBe('todowrite')
    expect(todoToolKind('Bash')).toBeUndefined()
  })

  it('TaskCreate 追加 pending;结果绑定 id;TaskUpdate 成功结果才折算', () => {
    const state = new TodoListState()
    expect(state.applyToolCall('TaskCreate', { subject: '改造后端' })).toBe(true)
    expect(state.snapshot()).toEqual([{ content: '改造后端', status: 'pending' }])

    state.applyToolResult('TaskCreate', 'Task #1 created successfully: 改造后端')

    state.deferTaskUpdate('c1', { taskId: '1', status: 'in_progress' })
    expect(state.resolveTaskUpdate('c1', 'Updated task #1 status')).toBe(true)
    expect(state.snapshot()).toEqual([{ content: '改造后端', status: 'in_progress' }])

    state.deferTaskUpdate('c2', { taskId: '1', status: 'completed' })
    expect(state.resolveTaskUpdate('c2', 'Updated task #1 status')).toBe(true)
    expect(state.snapshot()).toEqual([{ content: '改造后端', status: 'completed' }])
  })

  it('TaskUpdate 失败结果(not found)不同步——对齐 CodeBuddy 真实状态', () => {
    const state = new TodoListState()
    state.applyToolCall('TaskCreate', { subject: 'A' })
    state.applyToolResult('TaskCreate', 'Task #1 created successfully: A')

    state.deferTaskUpdate('c1', { taskId: '1', status: 'completed' })
    expect(state.resolveTaskUpdate('c1', 'Task with ID "1" not found')).toBe(false)
    expect(state.snapshot()).toEqual([{ content: 'A', status: 'pending' }])
    // 未 defer 的 callId 不生效。
    expect(state.resolveTaskUpdate('c-unknown', 'Updated task #1 status')).toBe(false)
  })

  it('todo_write 整表替换(同构)', () => {
    const state = new TodoListState()
    expect(state.applyToolCall('todo_write', {
      todos: [
        { content: 'A', status: 'in_progress' },
        { content: 'B', status: 'pending' },
      ],
    })).toBe(true)
    expect(state.snapshot()).toEqual([
      { content: 'A', status: 'in_progress' },
      { content: 'B', status: 'pending' },
    ])
    // 未知状态按 pending;空 content 条目丢弃。
    state.applyToolCall('todo_write', { todos: [{ content: 'C', status: 'weird' }, { content: '' }] })
    expect(state.snapshot()).toEqual([{ content: 'C', status: 'pending' }])
  })

  it('TaskUpdate deleted 移除条目并重排绑定', () => {
    const state = new TodoListState()
    state.applyToolCall('TaskCreate', { subject: 'A' })
    state.applyToolResult('TaskCreate', 'Task #1 created successfully: A')
    state.applyToolCall('TaskCreate', { subject: 'B' })
    state.applyToolResult('TaskCreate', 'Task #2 created successfully: B')

    state.deferTaskUpdate('c1', { taskId: '1', status: 'deleted' })
    expect(state.resolveTaskUpdate('c1', 'Updated task #1 status')).toBe(true)
    expect(state.snapshot()).toEqual([{ content: 'B', status: 'pending' }])
    // 原 #2 重排为索引 0,仍可更新。
    state.deferTaskUpdate('c2', { taskId: '2', status: 'completed' })
    expect(state.resolveTaskUpdate('c2', 'Updated task #2 status')).toBe(true)
    expect(state.snapshot()).toEqual([{ content: 'B', status: 'completed' }])
  })

  it('seed 从已提交事件折叠最新 todo/write', () => {
    const state = new TodoListState()
    state.seed([
      { type: 'todo/write', data: { todos: [{ content: '旧', status: 'pending' }] } },
      { type: 'todo/write', data: { todos: [{ content: '新', status: 'in_progress' }] } },
    ])
    expect(state.snapshot()).toEqual([{ content: '新', status: 'in_progress' }])
  })

  it('未绑定 id 且条目不唯一时 TaskUpdate 不生效(避免误改)', () => {
    const state = new TodoListState()
    state.applyToolCall('TaskCreate', { subject: 'A' })
    state.applyToolCall('TaskCreate', { subject: 'B' })
    state.deferTaskUpdate('c1', { taskId: '9', status: 'completed' })
    expect(state.resolveTaskUpdate('c1', 'Updated task #9 status')).toBe(false)
    expect(state.snapshot().every(item => item.status === 'pending')).toBe(true)
  })
})
