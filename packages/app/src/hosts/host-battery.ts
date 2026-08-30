import type { HostBattery } from "@getpaseo/protocol/messages";
import { useSessionStore } from "@/stores/session-store";

/**
 * The charge of the machine a host runs on, or null when it has none to report.
 *
 * Fed entirely by the daemon — the `server_info` handshake seeds it and `host_battery` pushes
 * keep it current — so there is nothing to fetch and nothing to poll here.
 */
export function useHostBattery(serverId: string | null): HostBattery | null {
  return useSessionStore((state) =>
    serverId ? (state.sessions[serverId]?.hostBattery ?? null) : null,
  );
}

// Cached the way `utils/time.ts` caches its date formatter, and for the same reason:
// constructing an Intl formatter is not cheap and this one runs on every badge render.
let cachedPercentFormatter: Intl.NumberFormat | null = null;
function getPercentFormatter(): Intl.NumberFormat {
  if (cachedPercentFormatter) return cachedPercentFormatter;
  cachedPercentFormatter = new Intl.NumberFormat(undefined, {
    style: "percent",
    maximumFractionDigits: 0,
  });
  return cachedPercentFormatter;
}

/**
 * The percent as the badge shows it.
 *
 * Clamped as well as rounded: the wire type is an unconstrained number by design — the protocol
 * will not narrow to 0-100 — so the display is where the range is enforced. Formatted through
 * Intl rather than a `${n}%` template because the separator and the digits are locale-specific;
 * French writes `37 %` and Arabic uses its own numerals.
 */
export function formatHostBatteryPercent(percent: number): string {
  if (!Number.isFinite(percent)) {
    return "";
  }
  const clamped = Math.round(Math.min(100, Math.max(0, percent)));
  return getPercentFormatter().format(clamped / 100);
}
