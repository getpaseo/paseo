import type { WorkspaceTabTarget } from "@/workspace-tabs/model";

/** Where a tab renders: a split pane, the Explorer dock, or the compact workspace sheet. */
export type PaneHost = "main" | "explorer" | "sheet";

/** How a target behaves while it is shown in the compact workspace sheet. */
export interface CompactSheetPolicy {
  /** The sheet offers Open as tab, which moves the same tab into the focused pane. */
  openAsTab: boolean;
}

/** Facts about a target that live outside the layout, resolved lazily by the workspace. */
export interface PanelTargetFacts {
  isWorkspaceRootAgent(agentId: string): boolean;
}

type CompactSheetRule<K extends WorkspaceTabTarget["kind"]> =
  | CompactSheetPolicy
  | null
  | ((
      target: Extract<WorkspaceTabTarget, { kind: K }>,
      facts: PanelTargetFacts,
    ) => CompactSheetPolicy | null);

export interface PanelManifest<K extends WorkspaceTabTarget["kind"] = WorkspaceTabTarget["kind"]> {
  kind: K;
  /** The sheet is never listed: a kind renders there exactly when it has a `compactSheet` rule. */
  supportedHosts: readonly Exclude<PaneHost, "sheet">[];
  showCloseButton: boolean;
  singleton: boolean;
  /**
   * On compact layouts, revealing this target opens it in the workspace sheet over the current
   * tab instead of adding a tab. `null` keeps it in the tab strip.
   */
  compactSheet: CompactSheetRule<K>;
  resourceKey(target: Extract<WorkspaceTabTarget, { kind: K }>): string;
}

type PanelManifestByKind = {
  [K in WorkspaceTabTarget["kind"]]: PanelManifest<K>;
};

const manifests = {
  new_tab: {
    kind: "new_tab",
    supportedHosts: ["main", "explorer"],
    showCloseButton: true,
    singleton: false,
    compactSheet: null,
    resourceKey: () => "new_tab",
  },
  draft: {
    kind: "draft",
    supportedHosts: ["main", "explorer"],
    showCloseButton: true,
    singleton: false,
    compactSheet: null,
    resourceKey: (target) => target.draftId,
  },
  agent: {
    kind: "agent",
    supportedHosts: ["main", "explorer"],
    showCloseButton: true,
    singleton: false,
    compactSheet: (target, facts) =>
      facts.isWorkspaceRootAgent(target.agentId) ? null : { openAsTab: true },
    resourceKey: (target) => target.agentId,
  },
  provider_subagent: {
    kind: "provider_subagent",
    supportedHosts: ["main", "explorer"],
    showCloseButton: true,
    singleton: false,
    compactSheet: { openAsTab: false },
    resourceKey: (target) => `${target.parentAgentId}:${target.subagentId}`,
  },
  terminal: {
    kind: "terminal",
    supportedHosts: ["main", "explorer"],
    showCloseButton: true,
    singleton: false,
    compactSheet: null,
    resourceKey: (target) => target.terminalId,
  },
  browser: {
    kind: "browser",
    supportedHosts: ["main"],
    showCloseButton: true,
    singleton: false,
    compactSheet: null,
    resourceKey: (target) => target.browserId,
  },
  changes_tree: {
    kind: "changes_tree",
    supportedHosts: ["explorer"],
    showCloseButton: false,
    singleton: true,
    compactSheet: null,
    resourceKey: () => "changes_tree",
  },
  files: {
    kind: "files",
    supportedHosts: ["explorer"],
    showCloseButton: false,
    singleton: true,
    compactSheet: null,
    resourceKey: () => "files",
  },
  pull_request: {
    kind: "pull_request",
    supportedHosts: ["main", "explorer"],
    showCloseButton: true,
    singleton: false,
    compactSheet: null,
    resourceKey: () => "pull_request",
  },
  file: {
    kind: "file",
    supportedHosts: ["main", "explorer"],
    showCloseButton: true,
    singleton: false,
    compactSheet: { openAsTab: false },
    resourceKey: (target) => target.path,
  },
  working_diff: {
    kind: "working_diff",
    supportedHosts: ["main", "explorer"],
    showCloseButton: true,
    singleton: false,
    compactSheet: null,
    resourceKey: () => "working_diff",
  },
  plugin: {
    kind: "plugin",
    // Plugin targets are narrowed by the target-aware plugin panel capability resolver.
    supportedHosts: ["main", "explorer"],
    showCloseButton: true,
    singleton: false,
    compactSheet: null,
    resourceKey: (target) =>
      target.context === "agent"
        ? `${target.pluginId}:${target.panelId}:agent:${target.agentId}`
        : `${target.pluginId}:${target.panelId}:workspace`,
  },
  setup: {
    kind: "setup",
    supportedHosts: ["main"],
    showCloseButton: true,
    singleton: false,
    compactSheet: null,
    resourceKey: (target) => target.workspaceId,
  },
  commit_diff: {
    kind: "commit_diff",
    supportedHosts: ["main", "explorer"],
    showCloseButton: true,
    singleton: false,
    compactSheet: null,
    resourceKey: (target) => target.sha,
  },
} satisfies PanelManifestByKind;

export function getPanelManifest<K extends WorkspaceTabTarget["kind"]>(kind: K): PanelManifest<K> {
  return manifests[kind] as unknown as PanelManifest<K>;
}

export function panelSupportsHost(kind: WorkspaceTabTarget["kind"], host: PaneHost): boolean {
  const manifest = getPanelManifest(kind);
  if (host === "sheet") return manifest.compactSheet !== null;
  return manifest.supportedHosts.includes(host);
}

export function panelCompactSheetPolicy(
  target: WorkspaceTabTarget,
  facts: PanelTargetFacts,
): CompactSheetPolicy | null {
  const rule = getPanelManifest(target.kind).compactSheet as CompactSheetRule<typeof target.kind>;
  return typeof rule === "function" ? rule(target as never, facts) : rule;
}

export function panelCanLaunchInPane(
  kind: WorkspaceTabTarget["kind"],
  panePanelKinds: readonly WorkspaceTabTarget["kind"][],
): boolean {
  return !getPanelManifest(kind).singleton || !panePanelKinds.includes(kind);
}

export function panelResourceKey(target: WorkspaceTabTarget): string {
  const manifest = getPanelManifest(target.kind);
  return `${target.kind}:${manifest.resourceKey(target as never)}`;
}
