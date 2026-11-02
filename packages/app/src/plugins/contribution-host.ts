const preferredHosts = new Map<string, string>();

export function getPreferredPluginContributionHost(contributionId: string): string | null {
  return preferredHosts.get(contributionId) ?? null;
}

export function rememberPluginContributionHost(contributionId: string, serverId: string): void {
  preferredHosts.set(contributionId, serverId);
}

/**
 * The host a plugin's screens and sidebar items share: the host last picked on one of its screens
 * or last opened from one of its items.
 */
export function pluginScreensHostKey(pluginId: string): string {
  return `${pluginId}/screens`;
}

// COMPAT(pluginSidebarAliases): added in v0.11.0, remove after 2027-03-29
/** The host an `addSidebarItem` row last opened, which its screen's host switcher also sets. */
export function legacySidebarItemHostKey(pluginId: string, itemId: string): string {
  return `${pluginId}/sidebar/${itemId}`;
}
