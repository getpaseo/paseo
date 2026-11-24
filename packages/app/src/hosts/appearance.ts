import { IDENTITY_COLOR_NAMES, type IdentityColorName } from "@/styles/identity-colors";
import type { HostProfile } from "@/types/host-connection";
import { z } from "zod";

export type HostColor = "none" | IdentityColorName;

export const HOST_COLORS: readonly HostColor[] = ["none", ...IDENTITY_COLOR_NAMES];

export const HOST_ICONS = [
  "server",
  "laptop",
  "desktop",
  "mini",
  "workstation",
  "cloud",
  "container",
  "board",
  "terminal",
] as const;

export type HostIcon = (typeof HOST_ICONS)[number];

export const DEFAULT_HOST_ICON: HostIcon = "server";

const HOST_ICON_SET = new Set<string>(HOST_ICONS);

export function normalizeDetectedHostIcon(value: string | null | undefined): HostIcon | null {
  const trimmed = value?.trim();
  if (trimmed && HOST_ICON_SET.has(trimmed)) {
    return trimmed as HostIcon;
  }
  return null;
}

export type HostBadgeDisplay = "name" | "icon" | "hidden";

export const HOST_BADGE_DISPLAYS: readonly HostBadgeDisplay[] = ["name", "icon", "hidden"];

/**
 * Per-device host presentation. Both `icon` and `badgeDisplay` are null while untouched so
 * runtime defaults apply (daemon-detected machine kind for icon; hidden for local / name for
 * remote on badgeDisplay) without baking runtime facts at parse time.
 */
export interface HostAppearance {
  color: HostColor;
  icon: HostIcon | null;
  badgeDisplay: HostBadgeDisplay | null;
}

const StoredHostAppearanceSchema = z.strictObject({
  color: z.enum(["none", ...IDENTITY_COLOR_NAMES]),
  // Loose string on disk so an icon added by a newer build falls back to auto ("null") instead of
  // failing the strict host parse and hiding the saved host.
  icon: z.string().nullable().optional(),
  badgeDisplay: z.enum(["name", "icon", "hidden"]).nullable(),
});

export const HostAppearanceSchema = StoredHostAppearanceSchema.transform(
  (value): HostAppearance => ({
    color: value.color,
    icon: normalizeDetectedHostIcon(value.icon),
    badgeDisplay: value.badgeDisplay,
  }),
);

export function defaultHostAppearance(): HostAppearance {
  return { color: "none", icon: null, badgeDisplay: null };
}

export function normalizeStoredHostAppearance(value: unknown): HostAppearance {
  const result = HostAppearanceSchema.safeParse(value);
  return result.success ? result.data : defaultHostAppearance();
}

export function resolveHostIcon(input: {
  appearance: HostAppearance;
  detectedMachineKind?: string | null;
}): HostIcon {
  if (input.appearance.icon) {
    return input.appearance.icon;
  }
  return normalizeDetectedHostIcon(input.detectedMachineKind) ?? DEFAULT_HOST_ICON;
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
  detectedMachineKindByServerId?: ReadonlyMap<string, string | null>;
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
      icon: resolveHostIcon({
        appearance: host.appearance,
        detectedMachineKind: input.detectedMachineKindByServerId?.get(host.serverId) ?? null,
      }),
      showLabel: display === "name",
    });
  }
  return badges;
}
