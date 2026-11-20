import type { ReactNode } from "react";

/**
 * Native: a hidden chat stays mounted and keeps rendering. Suspending a retained
 * native subtree hides its host views, tears down layout effects, and detaches
 * refs, which changes Fabric ownership (docs/mobile-panels.md). Activity-gated
 * work already stops through the retained-panel signal.
 */
export function RetainedChatContent({ children }: { children: ReactNode }) {
  return children;
}
