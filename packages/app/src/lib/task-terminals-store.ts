// taskTerminalsStore — adapted from emdash for React Native
// Manages per-task terminal state with AsyncStorage persistence
import AsyncStorage from "@react-native-async-storage/async-storage";

export interface TaskTerminal {
  id: string;
  title: string;
  cwd?: string;
  createdAt: number;
}

interface TaskTerminalsState {
  terminals: TaskTerminal[];
  activeId: string | null;
  counter: number;
}

export interface TaskTerminalSnapshot {
  terminals: TaskTerminal[];
  activeTerminalId: string | null;
}

const STORAGE_PREFIX = "hubcode:taskTerminals:v1";

const taskStates = new Map<string, TaskTerminalsState>();
const taskListeners = new Map<string, Set<() => void>>();
const taskSnapshots = new Map<string, TaskTerminalSnapshot>();

const EMPTY_SNAPSHOT: TaskTerminalSnapshot = {
  terminals: [],
  activeTerminalId: null,
};

function storageKey(taskId: string) {
  return `${STORAGE_PREFIX}:${taskId}`;
}

function buildSnapshot(state: TaskTerminalsState): TaskTerminalSnapshot {
  return { terminals: [...state.terminals], activeTerminalId: state.activeId };
}

function notify(taskId: string) {
  const state = taskStates.get(taskId);
  if (state) taskSnapshots.set(taskId, buildSnapshot(state));
  const set = taskListeners.get(taskId);
  if (set)
    for (const fn of set) {
      try {
        fn();
      } catch {}
    }
}

async function persist(taskId: string) {
  const state = taskStates.get(taskId);
  if (!state) return;
  try {
    await AsyncStorage.setItem(
      storageKey(taskId),
      JSON.stringify({ terminals: state.terminals, activeId: state.activeId }),
    );
  } catch {}
}

async function loadFromStorage(taskId: string): Promise<TaskTerminalsState | null> {
  try {
    const raw = await AsyncStorage.getItem(storageKey(taskId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return {
      terminals: parsed.terminals || [],
      activeId: parsed.activeId || null,
      counter: parsed.terminals?.length || 0,
    };
  } catch {
    return null;
  }
}

function getOrInit(taskId: string): TaskTerminalsState {
  let state = taskStates.get(taskId);
  if (!state) {
    state = { terminals: [], activeId: null, counter: 0 };
    taskStates.set(taskId, state);
  }
  return state;
}

export const taskTerminalsStore = {
  getSnapshot(taskId: string): TaskTerminalSnapshot {
    return taskSnapshots.get(taskId) || EMPTY_SNAPSHOT;
  },

  subscribe(taskId: string, listener: () => void): () => void {
    let set = taskListeners.get(taskId);
    if (!set) {
      set = new Set();
      taskListeners.set(taskId, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) taskListeners.delete(taskId);
    };
  },

  async init(taskId: string): Promise<void> {
    const saved = await loadFromStorage(taskId);
    if (saved) {
      taskStates.set(taskId, saved);
      taskSnapshots.set(taskId, buildSnapshot(saved));
      notify(taskId);
    }
  },

  createTerminal(taskId: string, cwd?: string): string {
    const state = getOrInit(taskId);
    state.counter += 1;
    const terminal: TaskTerminal = {
      id: `${taskId}-term-${state.counter}`,
      title: `Terminal ${state.counter}`,
      cwd,
      createdAt: Date.now(),
    };
    state.terminals.push(terminal);
    state.activeId = terminal.id;
    notify(taskId);
    void persist(taskId);
    return terminal.id;
  },

  setActive(taskId: string, terminalId: string) {
    const state = getOrInit(taskId);
    if (state.terminals.some((t) => t.id === terminalId)) {
      state.activeId = terminalId;
      notify(taskId);
      void persist(taskId);
    }
  },

  removeTerminal(taskId: string, terminalId: string) {
    const state = getOrInit(taskId);
    state.terminals = state.terminals.filter((t) => t.id !== terminalId);
    if (state.activeId === terminalId) {
      state.activeId = state.terminals[state.terminals.length - 1]?.id || null;
    }
    notify(taskId);
    void persist(taskId);
  },

  async dispose(taskId: string) {
    taskStates.delete(taskId);
    taskListeners.delete(taskId);
    taskSnapshots.delete(taskId);
    try {
      await AsyncStorage.removeItem(storageKey(taskId));
    } catch {}
  },
};
