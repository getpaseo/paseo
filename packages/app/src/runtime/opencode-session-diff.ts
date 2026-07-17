import type { DaemonServerInfo } from "@/stores/session-store";
import { hostSupportsFeature } from "@/runtime/host-features";

/**
 * Single-point capability detection for the OpenCode per-session diff feature.
 *
 * COMPAT(opencodeSessionDiff): added in v0.2.0, remove gate after 2027-01-18.
 * The daemon advertises `features.opencodeSessionDiff` once it can serve a
 * native `session.diff()` changed-files view. There is no fallback path: when
 * the host lacks the capability the client renders an "update host" affordance
 * instead of degrading. Drop this gate once the supported daemon floor is
 * >= v0.2.0.
 */
export function hostSupportsOpenCodeSessionDiff(
  serverInfo: DaemonServerInfo | null | undefined,
): boolean {
  return hostSupportsFeature(serverInfo, "opencodeSessionDiff");
}
