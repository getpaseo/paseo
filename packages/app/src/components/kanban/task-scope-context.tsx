// TaskScopeContext — adapted from emdash's TaskScopeContext.tsx
import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import type { TaskScopeInfo } from "@/types/task-scope";

const TaskScopeContext = createContext<TaskScopeInfo | null>(null);

export function TaskScopeProvider({
  value,
  children,
}: {
  value: TaskScopeInfo;
  children: ReactNode;
}) {
  return <TaskScopeContext.Provider value={value}>{children}</TaskScopeContext.Provider>;
}

export function useTaskScope(): TaskScopeInfo | null {
  return useContext(TaskScopeContext);
}
