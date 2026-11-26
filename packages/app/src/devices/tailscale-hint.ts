import type { TailscaleStatus } from "@getpaseo/protocol/messages";
import type { TFunction } from "i18next";

/** The line under the Tailscale label for each state the host reports, most specific first. */
export function describeTailscale(status: TailscaleStatus, t: TFunction): string {
  if (status.state === "unavailable") return t("devices.tailscale.unavailable");
  if (status.state === "waiting") return t("devices.tailscale.waiting");
  // A socket is why Tailscale cannot be on, even when the launch command also fixes the address.
  if (status.mainIsSocket) return t("devices.tailscale.socket");
  if (status.lockedBy === "launch") return t("devices.tailscale.launch");
  if (status.lockedBy === "main") return t("devices.tailscale.alwaysOn");
  return t("devices.tailscale.hint");
}
