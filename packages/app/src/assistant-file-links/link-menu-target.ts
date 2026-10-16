import type { InlinePathTarget } from "./parse";
import type { AssistantFileLinkResolution } from "./resolver";

export type LinkMenuTarget =
  | { kind: "external"; url: string }
  | { kind: "file"; path: string }
  | null;

/**
 * Which context menu a link gets. Web links can open inside Paseo or in the
 * default browser; file links can copy their absolute path or hand off to the
 * OS. Links that are neither keep the plain menu.
 *
 * A link that needs a daemon lookup only becomes actionable once the link
 * itself resolved (`resolvedTarget` is what the click path uses), so the menu
 * follows the same target instead of staying empty.
 */
export function resolveLinkMenuTarget(
  resolution: AssistantFileLinkResolution,
  resolvedTarget: InlinePathTarget | null,
): LinkMenuTarget {
  if (resolution.kind === "needsLookup") {
    return resolvedTarget ? { kind: "file", path: resolvedTarget.path } : null;
  }
  if (resolution.kind !== "resolved") {
    return null;
  }
  if (resolution.value.kind === "external") {
    return { kind: "external", url: resolution.value.url };
  }
  if (resolution.value.kind === "file") {
    return { kind: "file", path: resolution.value.target.path };
  }
  return null;
}
