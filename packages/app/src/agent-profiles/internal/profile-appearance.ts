import { IDENTITY_COLOR_NAMES, type IdentityColorName } from "@/styles/identity-colors";

/**
 * A profile's icon is a key into a fixed registry, not a glyph. The value is
 * stored in daemon config and drawn by every client, so it has to survive being
 * rendered by an app version that ships a different icon set — an unknown key
 * falls back to the default glyph rather than showing the raw string.
 *
 * Order is what the grid draws, five to a row: related icons sit together so
 * scanning the grid is scanning categories, not thirty unrelated shapes.
 */
export const AGENT_PROFILE_ICON_KEYS = [
  "code",
  "terminal",
  "bug",
  "wrench",
  "hammer",

  "flask",
  "testTube",
  "microscope",
  "search",
  "eye",

  "palette",
  "feather",
  "pencil",
  "fileText",
  "book",

  "rocket",
  "package",
  "boxes",
  "server",
  "database",

  "cpu",
  "cloud",
  "globe",
  "gitBranch",
  "layers",

  "compass",
  "brain",
  "sparkles",
  "shield",
] as const;

export type AgentProfileIconKey = (typeof AGENT_PROFILE_ICON_KEYS)[number];

/** Reuses the host identity palette so a profile and a host name read as one family. */
export type AgentProfileColor = "none" | IdentityColorName;

export const AGENT_PROFILE_COLORS: readonly AgentProfileColor[] = ["none", ...IDENTITY_COLOR_NAMES];

export function isAgentProfileIconKey(value: string | undefined): value is AgentProfileIconKey {
  return AGENT_PROFILE_ICON_KEYS.some((key) => key === value);
}

export function isAgentProfileColor(value: string | undefined): value is AgentProfileColor {
  return AGENT_PROFILE_COLORS.some((color) => color === value);
}

/** Anything unrecognised means "not chosen": the glyph and colour both default. */
export function resolveAgentProfileIconKey(value: string | undefined): AgentProfileIconKey | null {
  return isAgentProfileIconKey(value) ? value : null;
}

export function resolveAgentProfileColor(value: string | undefined): AgentProfileColor {
  return isAgentProfileColor(value) ? value : "none";
}
