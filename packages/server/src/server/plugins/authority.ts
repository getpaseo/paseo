import type { PluginSecurityCeiling } from "@getpaseo/plugin";

type SecurityDimension = keyof PluginSecurityCeiling;

const SECURITY_LEVELS: {
  readonly [Dimension in SecurityDimension]: Readonly<Record<string, number>>;
} = {
  filesystem: { none: 0, workspace: 1, unrestricted: 2, unknown: -1 },
  network: { none: 0, restricted: 1, unrestricted: 2, unknown: -1 },
  approvals: { none: 0, interactive: 1, preapproved: 2, unknown: -1 },
  unattended: { forbidden: 0, allowed: 1, unknown: -1 },
};

/**
 * Check a plugin request against the authority captured for one invocation.
 * Unknown ceilings do not authorize a permission. Explicit no-access values
 * remain safe even when the provider cannot report a ceiling.
 */
export function isPluginSecurityRequestAllowed(
  ceiling: PluginSecurityCeiling,
  request: Partial<PluginSecurityCeiling>,
): boolean {
  return (Object.entries(request) as [SecurityDimension, string][]).every(([dimension, value]) => {
    const requestedLevel = SECURITY_LEVELS[dimension][value];
    if (requestedLevel === undefined) return false;
    if (
      (dimension === "filesystem" && value === "none") ||
      (dimension === "network" && value === "none") ||
      (dimension === "approvals" && value === "none") ||
      (dimension === "unattended" && value === "forbidden")
    ) {
      return true;
    }
    const ceilingValue = ceiling[dimension];
    const ceilingLevel = SECURITY_LEVELS[dimension][ceilingValue];
    return (
      ceilingValue !== "unknown" && ceilingLevel !== undefined && requestedLevel <= ceilingLevel
    );
  });
}
