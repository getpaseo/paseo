import { useSyncExternalStore } from "react";
import type { WindowLayout } from "./model";

export type VerticalBarBehavior = "automatic" | "disabled";

/** The system vertical bar of a folded iPhone: the side rail that holds the status bar. */
export interface VerticalBarState {
  /** The edge iOS places the bar on; "none" where this window never has one. */
  readonly edge: WindowLayout["verticalBarEdge"];
  readonly behavior: VerticalBarBehavior;
}

const NO_BAR: VerticalBarState = { edge: "none", behavior: "automatic" };
let state: VerticalBarState = NO_BAR;
const listeners = new Set<() => void>();
let applyBehavior: (behavior: VerticalBarBehavior) => void = () => undefined;

export function subscribeVerticalBar(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getVerticalBar(): VerticalBarState {
  return state;
}

function publish(next: VerticalBarState): void {
  if (next.edge === state.edge && next.behavior === state.behavior) return;
  state = next;
  for (const listener of listeners) listener();
}

/** Called by the platform geometry probe with each measured layout. */
export function reportVerticalBarLayout(layout: WindowLayout | null): void {
  publish({
    edge: layout?.verticalBarEdge ?? "none",
    behavior: layout?.verticalBarBehavior ?? state.behavior,
  });
}

/** Installed by the platform that can change the bar. Elsewhere setting it does nothing. */
export function installVerticalBarController(apply: (behavior: VerticalBarBehavior) => void): void {
  applyBehavior = apply;
}

/**
 * Disabling the bar moves the status bar to the top and gives its column to the content. The
 * window's geometry then reports the new behavior, which confirms the change.
 */
export function setVerticalBarBehavior(behavior: VerticalBarBehavior): void {
  applyBehavior(behavior);
}

/** True while the app has turned the vertical bar off. */
export function useVerticalBarDisabled(): boolean {
  return (
    useSyncExternalStore(subscribeVerticalBar, getVerticalBar, getVerticalBar).behavior ===
    "disabled"
  );
}
