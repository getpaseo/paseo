import { IDENTITY_COLOR_NAMES, type IdentityColorName } from "@/styles/identity-colors";
import type { HostProfile } from "@/types/host-connection";
import { z } from "zod";

export type HostColor = "none" | IdentityColorName;

export const HOST_COLORS: readonly HostColor[] = ["none", ...IDENTITY_COLOR_NAMES];

export type HostBadgeDisplay = "name" | "icon" | "hidden";

export const HOST_BADGE_DISPLAYS: readonly HostBadgeDisplay[] = ["name", "icon", "hidden"];

/**
 * The glyph a host draws with, so two machines read apart at a glance. The daemon owns the
 * choice, so every device draws a host the same way; see `resolveHostIcon`.
 */
export const HOST_ICONS = [
  "server",
  "cloud",
  "desktop",
  "laptop",
  "workstation",
  "board",
  "container",
  "home",
  "office",
] as const;

export type HostIcon = (typeof HOST_ICONS)[number];

export const DEFAULT_HOST_ICON: HostIcon = "server";

function isHostIcon(value: unknown): value is HostIcon {
  return typeof value === "string" && (HOST_ICONS as readonly string[]).includes(value);
}

/** What a daemon reports about its icon: the user's choice and its own hardware guess. */
export interface HostIconInfo {
  selected: string | null;
  detected: string | null;
}

/** The detected icon, when the daemon guessed one this build can draw. */
export function detectedHostIcon(info: HostIconInfo | null | undefined): HostIcon | null {
  return isHostIcon(info?.detected) ? info.detected : null;
}

/**
 * The icon a host draws with: the user's choice, then the daemon's guess, then a plain server.
 * Both values are loose strings on the wire, so an icon this build doesn't know falls through.
 */
export function resolveHostIcon(info: HostIconInfo | null | undefined): HostIcon {
  if (isHostIcon(info?.selected)) return info.selected;
  return detectedHostIcon(info) ?? DEFAULT_HOST_ICON;
}

/**
 * Per-device host presentation. `badgeDisplay` is null while the user has not chosen,
 * because the default differs by host (local hides, remote shows) and local-ness is only
 * knowable from a desktop-only async query — never at parse time.
 */
export interface HostAppearance {
  color: HostColor;
  badgeDisplay: HostBadgeDisplay | null;
}

export const StoredHostAppearanceSchema = z.strictObject({
  color: z.enum(["none", ...IDENTITY_COLOR_NAMES]),
  badgeDisplay: z.enum(["name", "icon", "hidden"]).nullable(),
  // COMPAT(deviceHostIcon): builds that kept the host icon on the device stored it here. Accepted
  // and ignored so the strict parse doesn't drop those hosts; remove after 2027-04-01.
  icon: z.string().optional(),
});

export type StoredHostAppearance = z.infer<typeof StoredHostAppearanceSchema>;

export function defaultHostAppearance(): HostAppearance {
  return { color: "none", badgeDisplay: null };
}

export function hostAppearanceFromStored(stored: StoredHostAppearance): HostAppearance {
  return { color: stored.color, badgeDisplay: stored.badgeDisplay };
}

export function normalizeStoredHostAppearance(value: unknown): HostAppearance {
  const result = StoredHostAppearanceSchema.safeParse(value);
  return result.success ? hostAppearanceFromStored(result.data) : defaultHostAppearance();
}

export function resolveHostBadgeDisplay(input: {
  appearance: HostAppearance;
  isLocalHost: boolean;
  localHostResolutionPending?: boolean;
}): HostBadgeDisplay | null {
  if (input.appearance.badgeDisplay) {
    return input.appearance.badgeDisplay;
  }
  if (input.localHostResolutionPending) {
    return null;
  }
  return input.isLocalHost ? "hidden" : "name";
}

export interface HostBadgeModel {
  serverId: string;
  label: string;
  color: HostColor;
  icon: HostIcon;
  showLabel: boolean;
}

export type HostAppearanceSource = Pick<HostProfile, "serverId" | "label" | "appearance">;

/**
 * The sidebar's whole host-badge decision, resolved once per host list. Rows look their
 * badge up by serverId and render whatever they find; a host that should show no badge is
 * simply absent from the map.
 */
export function selectHostBadges(input: {
  hosts: readonly HostAppearanceSource[];
  localServerId: string | null;
  localHostResolutionPending?: boolean;
  /** Each connected host's icon as its daemon reports it; a host missing here draws a server. */
  hostIcons?: ReadonlyMap<string, HostIcon>;
  enabled: boolean;
}): ReadonlyMap<string, HostBadgeModel> {
  const badges = new Map<string, HostBadgeModel>();
  if (!input.enabled) {
    return badges;
  }
  for (const host of input.hosts) {
    const display = resolveHostBadgeDisplay({
      appearance: host.appearance,
      isLocalHost: host.serverId === input.localServerId,
      localHostResolutionPending: input.localHostResolutionPending,
    });
    if (display === null || display === "hidden") {
      continue;
    }
    badges.set(host.serverId, {
      serverId: host.serverId,
      label: host.label.trim() || host.serverId,
      color: host.appearance.color,
      icon: input.hostIcons?.get(host.serverId) ?? DEFAULT_HOST_ICON,
      showLabel: display === "name",
    });
  }
  return badges;
}
