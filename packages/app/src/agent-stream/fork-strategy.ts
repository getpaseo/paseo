import type { AssistantForkTarget } from "@/components/assistant-fork-menu";

/**
 * Map fork menu target to execution strategy.
 * Context draft fork is the reliable default for tab/workspace.
 * Native Claude SDK fork is opt-in via the experimental menu item.
 */
export function resolveAssistantForkStrategy(target: AssistantForkTarget): "context" | "native" {
  return target === "native-tab" ? "native" : "context";
}
