import { useSyncExternalStore } from "react";

/**
 * Drawing mode state for the shared-session "pencil" overlay. Kept tiny and
 * module-scoped — this only needs to toggle the overlay's pointer-events and
 * carry the current user's chosen color.
 */

export interface DrawState {
  active: boolean;
  color: string;
}

const PALETTE = ["#ff3b8d", "#4ade80", "#fbbf24", "#60a5fa", "#f97316", "#ffffff"];

function pickInitialColor(): string {
  const idx = Math.floor(Math.random() * PALETTE.length);
  return PALETTE[idx] ?? "#ff3b8d";
}

let state: DrawState = {
  active: false,
  color: pickInitialColor(),
};
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function setDrawActive(active: boolean): void {
  if (state.active === active) return;
  state = { ...state, active };
  emit();
}

export function toggleDrawActive(): void {
  setDrawActive(!state.active);
}

export function setDrawColor(color: string): void {
  if (state.color === color) return;
  state = { ...state, color };
  emit();
}

export function getDrawSnapshot(): DrawState {
  return state;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useSharedDrawState(): DrawState {
  return useSyncExternalStore(subscribe, getDrawSnapshot, getDrawSnapshot);
}

export const DRAW_PALETTE = PALETTE;
