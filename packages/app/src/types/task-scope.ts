// Task scope context types — adapted from emdash's TaskScopeContext

export interface TaskScopeInfo {
  taskId: string;
  taskPath: string;
  projectPath?: string;
  prNumber?: number | null;
}
