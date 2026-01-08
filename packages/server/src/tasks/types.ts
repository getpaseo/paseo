export type TaskStatus = "draft" | "open" | "in_progress" | "done";

export type AgentType = "claude" | "codex";

export interface Note {
  timestamp: string; // ISO date
  content: string; // markdown
}

export interface Task {
  id: string; // random hash, e.g. "a1b2c3d4"
  title: string;
  status: TaskStatus;
  deps: string[];
  description: string; // long form markdown
  notes: Note[];
  created: string; // ISO date
  assignee?: AgentType; // optional agent override
}

export interface CreateTaskOptions {
  deps?: string[];
  status?: TaskStatus;
  description?: string;
  assignee?: AgentType;
}

export interface TaskStore {
  // Queries
  list(): Promise<Task[]>;
  get(id: string): Promise<Task | null>;
  getDepTree(id: string): Promise<Task[]>; // all descendants in dep graph
  getReady(scopeId?: string): Promise<Task[]>; // open + all deps done, optionally scoped
  getBlocked(scopeId?: string): Promise<Task[]>; // open/in_progress but has unresolved deps
  getClosed(scopeId?: string): Promise<Task[]>; // done tasks, optionally scoped

  // Mutations
  create(title: string, opts?: CreateTaskOptions): Promise<Task>;
  update(id: string, changes: Partial<Omit<Task, "id" | "created">>): Promise<Task>;
  addDep(id: string, depId: string): Promise<void>;
  removeDep(id: string, depId: string): Promise<void>;
  addNote(id: string, content: string): Promise<void>;

  // Status transitions
  open(id: string): Promise<void>; // draft -> open
  start(id: string): Promise<void>; // open -> in_progress
  close(id: string): Promise<void>; // any -> done
}
