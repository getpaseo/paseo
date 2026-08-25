import type { WorkspaceTabTarget } from "@/workspace-tabs/model";

export type PaneHost = "main" | "explorer";

export interface PanelManifest<K extends WorkspaceTabTarget["kind"] = WorkspaceTabTarget["kind"]> {
  kind: K;
  supportedHosts: readonly PaneHost[];
  resourceKey(target: Extract<WorkspaceTabTarget, { kind: K }>): string;
}

type PanelManifestByKind = {
  [K in WorkspaceTabTarget["kind"]]: PanelManifest<K>;
};

const manifests = {
  new_tab: {
    kind: "new_tab",
    supportedHosts: ["main", "explorer"],
    resourceKey: () => "new_tab",
  },
  draft: {
    kind: "draft",
    supportedHosts: ["main", "explorer"],
    resourceKey: (target) => target.draftId,
  },
  agent: {
    kind: "agent",
    supportedHosts: ["main", "explorer"],
    resourceKey: (target) => target.agentId,
  },
  provider_subagent: {
    kind: "provider_subagent",
    supportedHosts: ["main", "explorer"],
    resourceKey: (target) => `${target.parentAgentId}:${target.subagentId}`,
  },
  terminal: {
    kind: "terminal",
    supportedHosts: ["main", "explorer"],
    resourceKey: (target) => target.terminalId,
  },
  browser: {
    kind: "browser",
    supportedHosts: ["main"],
    resourceKey: (target) => target.browserId,
  },
  changes_tree: {
    kind: "changes_tree",
    supportedHosts: ["explorer"],
    resourceKey: () => "changes_tree",
  },
  files: {
    kind: "files",
    supportedHosts: ["explorer"],
    resourceKey: () => "files",
  },
  pull_request: {
    kind: "pull_request",
    supportedHosts: ["main", "explorer"],
    resourceKey: () => "pull_request",
  },
  file: {
    kind: "file",
    supportedHosts: ["main", "explorer"],
    resourceKey: (target) => target.path,
  },
  working_diff: {
    kind: "working_diff",
    supportedHosts: ["main", "explorer"],
    resourceKey: () => "working_diff",
  },
  plugin: {
    kind: "plugin",
    // Plugin targets are narrowed by the target-aware plugin panel capability resolver.
    supportedHosts: ["main", "explorer"],
    resourceKey: (target) =>
      target.context === "agent"
        ? `${target.pluginId}:${target.panelId}:agent:${target.agentId}`
        : `${target.pluginId}:${target.panelId}:workspace`,
  },
  setup: {
    kind: "setup",
    supportedHosts: ["main"],
    resourceKey: (target) => target.workspaceId,
  },
  commit_diff: {
    kind: "commit_diff",
    supportedHosts: ["main", "explorer"],
    resourceKey: (target) => target.sha,
  },
} satisfies PanelManifestByKind;

export function getPanelManifest<K extends WorkspaceTabTarget["kind"]>(kind: K): PanelManifest<K> {
  return manifests[kind] as unknown as PanelManifest<K>;
}

export function panelSupportsHost(kind: WorkspaceTabTarget["kind"], host: PaneHost): boolean {
  return getPanelManifest(kind).supportedHosts.includes(host);
}

export function panelResourceKey(target: WorkspaceTabTarget): string {
  const manifest = getPanelManifest(target.kind);
  return `${target.kind}:${manifest.resourceKey(target as never)}`;
}
