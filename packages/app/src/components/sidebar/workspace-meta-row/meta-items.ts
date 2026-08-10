import type { PrHint } from "@/git/pr-hint";
import type { SidebarChecksDisplay } from "@/components/sidebar/display-preferences/checks-display";
import type { SidebarRowItems } from "@/components/sidebar/display-preferences/row-items";
import { selectCheckSummary, type CheckSummary } from "./check-summary";
import type { WorkspaceServiceSummary } from "./service-summary";

/**
 * What ends up on the line under a workspace title, in the order it is read: where the
 * workspace lives, what change it belongs to, whether that change is passing, and what it is
 * running. Identity first, then the work, then the work's state.
 */
export type MetaRowItem =
  | { kind: "host" }
  | { kind: "project"; name: string }
  | { kind: "changeRequest"; hint: PrHint }
  | { kind: "checks"; summary: CheckSummary; label: boolean }
  | { kind: "services"; summary: WorkspaceServiceSummary };

/**
 * Which peers a row should draw, given what it knows and what the user left switched on.
 *
 * Kept out of the component because this — not the markup — is the part with rules in it: every
 * toggle answers for itself, so a row can end up showing checks with no change request beside
 * them, and CI resolves from the hint even when the hint itself is not drawn.
 *
 * The host is filtered upstream, where the badge map is built: a host that should show nothing
 * has no badge to hand down, so by the time a row sees one it is meant to be drawn.
 */
export function selectMetaRowItems(input: {
  projectName: string | null;
  hasHostBadge: boolean;
  prHint: PrHint | null;
  serviceSummary: WorkspaceServiceSummary | null;
  visible: SidebarRowItems;
  checksDisplay: SidebarChecksDisplay;
}): MetaRowItem[] {
  const { projectName, hasHostBadge, prHint, serviceSummary, visible, checksDisplay } = input;
  const items: MetaRowItem[] = [];

  if (hasHostBadge) {
    items.push({ kind: "host" });
  }
  if (projectName) {
    items.push({ kind: "project", name: projectName });
  }
  if (prHint && visible.changeRequest) {
    items.push({ kind: "changeRequest", hint: prHint });
  }

  // Independent of the change request, even though checks are read off one. Tying them together
  // meant the checks setting could sit on a value while nothing was drawn, which is a control that
  // lies about its own state. Showing checks without the change request beside them is the
  // stranger combination, but it is the one you asked for and it is what you get.
  if (checksDisplay !== "none") {
    const summary = selectCheckSummary(prHint);
    if (summary) {
      items.push({ kind: "checks", summary, label: checksDisplay === "iconAndText" });
    }
  }

  if (serviceSummary && visible.services) {
    items.push({ kind: "services", summary: serviceSummary });
  }

  return items;
}
