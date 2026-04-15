// Lightweight derived status store for tasks based on agent activity
// Adapted from emdash — uses WebSocket activity instead of PTY
import { activityStore } from "./activity-store";

export type DerivedStatus = "idle" | "busy";
type Listener = (status: DerivedStatus) => void;

const statusByTask = new Map<string, DerivedStatus>();
const listenersByTask = new Map<string, Set<Listener>>();
const lastActivity = new Map<string, number>();

const IDLE_AFTER_MS = 12_000;
let tickStarted = false;

function ensureTicker() {
  if (tickStarted) return;
  tickStarted = true;
  setInterval(() => {
    const now = Date.now();
    for (const [tid, ts] of lastActivity.entries()) {
      const cur = statusByTask.get(tid) || "idle";
      if (cur === "busy" && now - ts > IDLE_AFTER_MS) {
        setStatusInternal(tid, "idle");
      }
    }
  }, 2_000);
}

function setStatusInternal(taskId: string, next: DerivedStatus) {
  const prev = statusByTask.get(taskId) || "idle";
  if (prev === next) return;
  statusByTask.set(taskId, next);
  const ls = listenersByTask.get(taskId);
  if (ls)
    for (const fn of Array.from(ls)) {
      try {
        fn(next);
      } catch {}
    }
}

export function getDerivedStatus(taskId: string): DerivedStatus {
  ensureTicker();
  return statusByTask.get(taskId) || "idle";
}

export function subscribeDerivedStatus(taskId: string, listener: Listener): () => void {
  ensureTicker();
  let set = listenersByTask.get(taskId);
  if (!set) {
    set = new Set();
    listenersByTask.set(taskId, set);
  }
  set.add(listener);
  try {
    listener(getDerivedStatus(taskId));
  } catch {}
  return () => {
    const s = listenersByTask.get(taskId);
    if (!s) return;
    s.delete(listener);
    if (s.size === 0) listenersByTask.delete(taskId);
  };
}

/** Mark a task as busy from external activity (e.g. WebSocket message) */
export function markTaskBusy(taskId: string) {
  lastActivity.set(taskId, Date.now());
  setStatusInternal(taskId, "busy");
}

/** Mark a task as idle */
export function markTaskIdle(taskId: string) {
  lastActivity.set(taskId, Date.now());
  setStatusInternal(taskId, "idle");
}

/** Watch task activity via the shared activityStore */
export function watchTaskActivity(taskId: string): () => void {
  ensureTicker();
  return activityStore.subscribe(taskId, (isBusy) => {
    lastActivity.set(taskId, Date.now());
    setStatusInternal(taskId, isBusy ? "busy" : "idle");
  });
}
