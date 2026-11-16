import { IDENTITY_COLOR_NAMES, type IdentityColorName } from "@/styles/identity-colors";
import type { HostProfile } from "@/types/host-connection";
import { z } from "zod";

export type HostColor = "none" | IdentityColorName;

export const HOST_COLORS: readonly HostColor[] = ["none", ...IDENTITY_COLOR_NAMES];

export type HostBadgeDisplay = "name" | "icon" | "hidden";

export const HOST_BADGE_DISPLAYS: readonly HostBadgeDisplay[] = ["name", "icon", "hidden"];

/** The glyph a host draws with, so two machines read apart at a glance. */
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

/**
 * Per-device host presentation. `badgeDisplay` is null while the user has not chosen,
 * because the default differs by host (local hides, remote shows) and local-ness is only
 * knowable from a desktop-only async query — never at parse time.
 */
export interface HostAppearance {
  color: HostColor;
  badgeDisplay: HostBadgeDisplay | null;
  icon: HostIcon;
}

/**
 * The stored shape. `icon` is optional because registries written before it existed lack it,
 * and a loose string because a newer build may store an icon this build doesn't know — that
 * host falls back to the default glyph instead of failing the strict parse and being dropped.
 */
export const StoredHostAppearanceSchema = z.strictObject({
  color: z.enum(["none", ...IDENTITY_COLOR_NAMES]),
  badgeDisplay: z.enum(["name", "icon", "hidden"]).nullable(),
  icon: z.string().optional(),
});

export type StoredHostAppearance = z.infer<typeof StoredHostAppearanceSchema>;

export function defaultHostAppearance(): HostAppearance {
  return { color: "none", badgeDisplay: null, icon: DEFAULT_HOST_ICON };
}

export function hostAppearanceFromStored(stored: StoredHostAppearance): HostAppearance {
  return {
    color: stored.color,
    badgeDisplay: stored.badgeDisplay,
    icon: isHostIcon(stored.icon) ? stored.icon : DEFAULT_HOST_ICON,
  };
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
      icon: host.appearance.icon,
      showLabel: display === "name",
    });
  }
  return badges;
}
