export type TaskStatus = "draft" | "open" | "in_progress" | "done" | "failed";

export type AgentType = "claude" | "codex";

export type ModelName =
  | "haiku"
  | "sonnet"
  | "opus"
  | `gpt-${string}`;

export interface Note {
  timestamp: string; // ISO date
  content: string; // markdown
}

export interface Task {
  id: string; // random hash, e.g. "a1b2c3d4"
  title: string;
  status: TaskStatus;
  deps: string[]; // task IDs this task depends on (must be done before this can start)
  parentId?: string; // parent task ID for hierarchical structure (context inheritance)
  body: string; // long form markdown document
  acceptanceCriteria: string[]; // immutable checklist items for verification
  notes: Note[];
  created: string; // ISO date
  assignee?: AgentType; // optional agent override
  priority?: number; // lower number = higher priority (1 is highest), tasks with priority sort before those without
  raw: string; // the raw markdown file content
}

export interface CreateTaskOptions {
  deps?: string[];
  parentId?: string;
  status?: TaskStatus;
  body?: string;
  acceptanceCriteria?: string[];
  assignee?: AgentType;
  priority?: number;
}

export interface TaskStore {
  // Queries
  list(): Promise<Task[]>;
  get(id: string): Promise<Task | null>;
  getDepTree(id: string): Promise<Task[]>; // all descendants in dep graph
  getAncestors(id: string): Promise<Task[]>; // parent chain from immediate parent to root
  getChildren(id: string): Promise<Task[]>; // direct children of a task
  getReady(scopeId?: string): Promise<Task[]>; // open + all deps done, optionally scoped
  getBlocked(scopeId?: string): Promise<Task[]>; // open/in_progress but has unresolved deps
  getClosed(scopeId?: string): Promise<Task[]>; // done tasks, optionally scoped

  // Mutations
  create(title: string, opts?: CreateTaskOptions): Promise<Task>;
  update(id: string, changes: Partial<Omit<Task, "id" | "created">>): Promise<Task>;
  delete(id: string): Promise<void>;
  addDep(id: string, depId: string): Promise<void>;
  removeDep(id: string, depId: string): Promise<void>;
  setParent(id: string, parentId: string | null): Promise<void>;
  addNote(id: string, content: string): Promise<void>;

  // Status transitions
  open(id: string): Promise<void>; // draft -> open
  start(id: string): Promise<void>; // open -> in_progress
  close(id: string): Promise<void>; // any -> done
  fail(id: string): Promise<void>; // any -> failed

  // Acceptance criteria
  addAcceptanceCriteria(id: string, criterion: string): Promise<void>;
}
