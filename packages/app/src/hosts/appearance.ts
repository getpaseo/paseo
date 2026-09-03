import {
  IDENTITY_COLOR_NAMES,
  identityColor,
  type IdentityColorName,
} from "@/styles/identity-colors";
import type { HostProfile } from "@/types/host-connection";
import { z } from "zod";

export type CustomHostColor = `#${string}`;
export type PresetHostColor = "none" | IdentityColorName;
export type HostColor = PresetHostColor | CustomHostColor;

export const HOST_COLORS: readonly PresetHostColor[] = ["none", ...IDENTITY_COLOR_NAMES];

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

const CustomHostColorSchema = z
  .custom<CustomHostColor>((value) => normalizeCustomHostColor(value) !== null)
  .transform((value) => normalizeCustomHostColor(value) ?? value);

export const HostAppearanceSchema: z.ZodType<HostAppearance> = z.strictObject({
  color: z.union([z.enum(["none", ...IDENTITY_COLOR_NAMES]), CustomHostColorSchema]),
  badgeDisplay: z.enum(["name", "icon", "hidden"]).nullable(),
});

export function defaultHostAppearance(): HostAppearance {
  return { color: "none", badgeDisplay: null };
}

export function normalizeCustomHostColor(value: unknown): CustomHostColor | null {
  if (typeof value !== "string") {
    return null;
  }
  const digits = value.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(digits)) {
    const expanded = [...digits].map((digit) => `${digit}${digit}`).join("");
    return `#${expanded.toLowerCase()}`;
  }
  if (/^[0-9a-fA-F]{6}$/.test(digits)) {
    return `#${digits.toLowerCase()}`;
  }
  return null;
}

export function isCustomHostColor(color: HostColor): color is CustomHostColor {
  return color.startsWith("#");
}

export function hostColorValue(color: HostColor): string | null {
  if (color === "none") {
    return null;
  }
  return isCustomHostColor(color) ? color : identityColor(color);
}

export function normalizeStoredHostAppearance(value: unknown): HostAppearance {
  const result = HostAppearanceSchema.safeParse(value);
  return result.success ? result.data : defaultHostAppearance();
}

export function resolveHostBadgeDisplay(input: {
  appearance: HostAppearance;
  isLocalHost: boolean;
  localHostResolutionPending?: boolean;
  alwaysShowHostLabels?: boolean;
}): HostBadgeDisplay | null {
  if (input.appearance.badgeDisplay) {
    return input.appearance.badgeDisplay;
  }
  if (input.alwaysShowHostLabels) {
    return "name";
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
  alwaysShowHostLabels?: boolean;
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
      alwaysShowHostLabels: input.alwaysShowHostLabels,
    });
    if (display === null || display === "hidden") {
      continue;
    }
    badges.set(host.serverId, {
      serverId: host.serverId,
      label: host.label.trim() || host.serverId,
      color: host.appearance.color,
      showLabel: display === "name",
    });
  }
  return badges;
}
