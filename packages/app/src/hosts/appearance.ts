import {
  IDENTITY_COLOR_NAMES,
  deriveIdentityColorName,
  type IdentityColorName,
} from "@/styles/identity-colors";
import type { HostProfile } from "@/types/host-connection";
import { z } from "zod";

/** `"none"` is "no choice on this device": the host's declared color, else a derived one. */
export type HostColor = "none" | IdentityColorName;

export const HOST_COLORS: readonly HostColor[] = ["none", ...IDENTITY_COLOR_NAMES];

export type HostBadgeDisplay = "name" | "icon" | "hidden";

export const HOST_BADGE_DISPLAYS: readonly HostBadgeDisplay[] = ["name", "icon", "hidden"];

/**
 * Per-device host presentation. `badgeDisplay` is null while the user has not chosen,
 * because the default differs by host (local hides, remote shows) and local-ness is only
 * knowable from a desktop-only async query — never at parse time.
 */
export interface HostAppearance {
  color: HostColor;
  badgeDisplay: HostBadgeDisplay | null;
}

export const HostAppearanceSchema: z.ZodType<HostAppearance> = z.strictObject({
  color: z.enum(["none", ...IDENTITY_COLOR_NAMES]),
  badgeDisplay: z.enum(["name", "icon", "hidden"]).nullable(),
});

export function defaultHostAppearance(): HostAppearance {
  return { color: "none", badgeDisplay: null };
}

export function normalizeStoredHostAppearance(value: unknown): HostAppearance {
  const result = HostAppearanceSchema.safeParse(value);
  return result.success ? result.data : defaultHostAppearance();
}

/**
 * The color a host has before any device chooses: what the host declares for itself, else one
 * derived from the server id. Both are the same on every device, so hosts line up across
 * clients without anyone configuring anything.
 */
export function resolveHostDefaultColor(input: {
  serverId: string;
  declaredColor: IdentityColorName | null;
}): IdentityColorName {
  return input.declaredColor ?? deriveIdentityColorName(input.serverId);
}

export function resolveHostColor(input: {
  serverId: string;
  appearance: HostAppearance;
  declaredColor: IdentityColorName | null;
}): IdentityColorName {
  return input.appearance.color === "none"
    ? resolveHostDefaultColor(input)
    : input.appearance.color;
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
  color: IdentityColorName;
  showLabel: boolean;
}

export type HostAppearanceSource = Pick<
  HostProfile,
  "serverId" | "label" | "appearance" | "declaredColor"
>;

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
      color: resolveHostColor(host),
      showLabel: display === "name",
    });
  }
  return badges;
}
