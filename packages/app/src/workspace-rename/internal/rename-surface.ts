import { UnistylesRuntime } from "react-native-unistyles";
import { isWeb } from "@/constants/platform";

export type WorkspaceRenameSurface = "inline" | "modal";

/**
 * Read when a rename starts rather than subscribed to: the surface is chosen once per rename, and
 * a subscription would re-render every sidebar row on each breakpoint change.
 *
 * Native wide layouts keep the modal. Their sidebar rows are touch targets with a permanent
 * kebab, and the iPad overlay-dismissal flows drive the modal.
 */
export function resolveWorkspaceRenameSurface(): WorkspaceRenameSurface {
  if (!isWeb) return "modal";
  const breakpoint = UnistylesRuntime.breakpoint;
  return breakpoint === "lg" || breakpoint === "xl" ? "inline" : "modal";
}
