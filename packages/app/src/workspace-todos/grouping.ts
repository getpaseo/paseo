import type { WorkspaceTodo } from "@getpaseo/protocol/workspace-todos";

export interface TodoMilestone {
  name: string;
  tasks: WorkspaceTodo[];
}

export function groupTodoMilestones(tasks: WorkspaceTodo[]): TodoMilestone[] {
  const groups = new Map<string, TodoMilestone>();
  for (const task of tasks) {
    const name = task.milestone ?? "";
    let group = groups.get(name);
    if (!group) {
      group = { name, tasks: [] };
      groups.set(name, group);
    }
    group.tasks.push(task);
  }
  return [...groups.values()];
}

// A drag only owns its visible subset; unrelated groups keep their positions.
export function mergeTodoOrder(tasks: WorkspaceTodo[], reordered: WorkspaceTodo[]): string[] {
  const ids = new Set(reordered.map((task) => task.id));
  let next = 0;
  return tasks.map((task) => (ids.has(task.id) ? reordered[next++]!.id : task.id));
}
