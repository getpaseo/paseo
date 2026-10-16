export type OrderIntent =
  | { kind: "workspaces"; projectViewKey: string; moved: string; before: string[]; after: string[] }
  | { kind: "pinned"; moved: string; before: string[]; after: string[] }
  | { kind: "tabs"; workspaceKey: string; paneId: string; movedTabId: string };

const listeners = new Set<(intent: OrderIntent) => void>();
let gestureDepth = 0;
export function isOrderGesture(): boolean {
  return gestureDepth > 0;
}
export function observeOrderIntents(listener: (intent: OrderIntent) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
/** Directory reconciliation and remote application never enter the gesture boundary. */
export function performOrderGesture(intent: OrderIntent, action: () => void): void {
  gestureDepth++;
  try {
    action();
  } finally {
    gestureDepth--;
  }
  for (const listener of listeners) listener(intent);
}

export interface OrderError {
  kind: "unsupported" | "failed" | "conflict";
  detail?: string;
}
const errorListeners = new Set<(error: OrderError) => void>();
export function observeOrderErrors(listener: (error: OrderError) => void): () => void {
  errorListeners.add(listener);
  return () => {
    errorListeners.delete(listener);
  };
}
export function reportOrderError(error: OrderError): void {
  for (const listener of errorListeners) listener(error);
}
