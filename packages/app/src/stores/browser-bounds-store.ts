import { useSyncExternalStore } from "react";

export interface BrowserRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

let rects: Record<string, BrowserRect> = {};
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function setBrowserRect(browserId: string, rect: BrowserRect): void {
  const prev = rects[browserId];
  if (
    prev &&
    prev.x === rect.x &&
    prev.y === rect.y &&
    prev.width === rect.width &&
    prev.height === rect.height
  ) {
    return;
  }
  rects = { ...rects, [browserId]: rect };
  emit();
}

export function clearBrowserRect(browserId: string): void {
  if (!(browserId in rects)) return;
  const next = { ...rects };
  delete next[browserId];
  rects = next;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): Record<string, BrowserRect> {
  return rects;
}

export function useBrowserRects(): Record<string, BrowserRect> {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function rectsIntersect(a: BrowserRect, b: BrowserRect): boolean {
  return !(
    a.x + a.width <= b.x ||
    b.x + b.width <= a.x ||
    a.y + a.height <= b.y ||
    b.y + b.height <= a.y
  );
}
