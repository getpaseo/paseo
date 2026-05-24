import type { RewindMode } from "./use-rewind-capabilities";

export function shouldRestoreComposerForRewindMode(mode: RewindMode): boolean {
  return mode === "conversation" || mode === "both";
}
