import { UnistylesRuntime } from "react-native-unistyles";
import { allowsInlineWorkspaceRename } from "@/constants/presentation";

export type WorkspaceRenameSurface = "inline" | "modal";

/**
 * Read when a rename starts rather than subscribed to: the surface is chosen once per rename, and
 * a subscription would re-render every sidebar row on each breakpoint change.
 *
 * Mobile native wide layouts keep the modal. Their sidebar rows are touch targets with a permanent
 * kebab, and the iPad overlay-dismissal flows drive the modal.
 */
export function resolveWorkspaceRenameSurface(): WorkspaceRenameSurface {
  if (!allowsInlineWorkspaceRename) return "modal";
  const breakpoint = UnistylesRuntime.breakpoint;
  return breakpoint === "lg" || breakpoint === "xl" ? "inline" : "modal";
}
