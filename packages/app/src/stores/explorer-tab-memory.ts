export type ExplorerTab = "changes" | "files" | "pr" | "activity" | "chapters";

export function isExplorerTab(value: unknown): value is ExplorerTab {
  return (
    value === "chapters" ||
    value === "changes" ||
    value === "files" ||
    value === "pr" ||
    value === "activity"
  );
}

export function buildExplorerCheckoutKey(serverId: string, cwd: string): string | null {
  const trimmedServerId = serverId.trim();
  const trimmedCwd = cwd.trim();
  if (!trimmedServerId || !trimmedCwd) {
    return null;
  }
  return `${trimmedServerId}::${trimmedCwd}`;
}

export function coerceExplorerTabForCheckout(tab: ExplorerTab, isGit: boolean): ExplorerTab {
  if (!isGit && (tab === "changes" || tab === "chapters")) {
    return "files";
  }
  return tab;
}

export function resolveExplorerTabForCheckout(params: {
  serverId: string;
  cwd: string;
  isGit: boolean;
  explorerTabByCheckout: Record<string, ExplorerTab>;
}): ExplorerTab {
  const key = buildExplorerCheckoutKey(params.serverId, params.cwd);
  const stored = key ? params.explorerTabByCheckout[key] : null;
  const defaultTab: ExplorerTab = params.isGit ? "changes" : "files";
  const nextTab = stored && isExplorerTab(stored) ? stored : defaultTab;
  return coerceExplorerTabForCheckout(nextTab, params.isGit);
}
