import type { Theme } from "@/styles/theme";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";

export function getStatusDotColor(input: {
  theme: Theme;
  bucket: SidebarStateBucket;
  showDoneAsInactive?: boolean;
}): string | null {
  const { theme, bucket, showDoneAsInactive = false } = input;

  // The one place the statusDot* band is read. Dots sit louder than the check icons and host
  // badges on the same row — see the band's note in theme.ts — so going through the status
  // family here instead would quietly put the row's state below its metadata.
  //
  // needs_input is amber because it wants something from you. Working is blue: an agent doing
  // its job is the one busy state that asks for nothing, so it should not sit in the same
  // color as the states that do.
  if (bucket === "needs_input") {
    return theme.colors.statusDotWarning;
  }
  if (bucket === "failed") {
    return theme.colors.statusDotDanger;
  }
  if (bucket === "running" || bucket === "waiting_on_subagent") {
    // Waiting shares running's color on purpose: the work is still moving and asks nothing of the
    // user. The label — not the dot — separates "this agent is working" from "this agent is
    // waiting on a subagent", because a dot has no room for either.
    return theme.colors.statusDotRunning;
  }
  if (bucket === "attention") {
    return theme.colors.statusDotSuccess;
  }
  if (bucket === "done") {
    return showDoneAsInactive ? theme.colors.border : null;
  }
  return null;
}
