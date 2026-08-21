const preferredHosts = new Map<string, string>();

export function getPreferredPluginContributionHost(contributionId: string): string | null {
  return preferredHosts.get(contributionId) ?? null;
}

export function rememberPluginContributionHost(contributionId: string, serverId: string): void {
  preferredHosts.set(contributionId, serverId);
}
