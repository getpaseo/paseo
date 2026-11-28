import { z } from "zod";

export const WorkspaceSplitSyncModeSchema = z.enum(["off", "desktop", "all"]);
export type WorkspaceSplitSyncMode = z.infer<typeof WorkspaceSplitSyncModeSchema>;
export const MAX_WORKSPACE_SHARED_TABS = 1024;

const id = z.string().min(1);
const ids = z.array(id).max(MAX_WORKSPACE_SHARED_TABS);
const BuiltinSharedTabTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("agent"), agentId: id }),
  z.strictObject({ kind: z.literal("provider_subagent"), parentAgentId: id, subagentId: id }),
  z.strictObject({ kind: z.literal("terminal"), terminalId: id }),
  z.strictObject({ kind: z.literal("file"), path: id }),
  z.strictObject({ kind: z.literal("working_diff") }),
  z.strictObject({ kind: z.literal("changes_tree") }),
  z.strictObject({ kind: z.literal("files") }),
  z.strictObject({ kind: z.literal("pull_request") }),
  z.strictObject({ kind: z.literal("setup"), workspaceId: id }),
]);
const pluginTarget = { kind: z.literal("plugin"), pluginId: id, panelId: id };
const PluginSharedTabTargetSchema = z.discriminatedUnion("context", [
  z.strictObject({ ...pluginTarget, context: z.literal("workspace") }),
  z.strictObject({ ...pluginTarget, context: z.literal("agent"), agentId: id }),
]);

// zod-aot 0.20.4 drops a discriminated union used directly as a discriminated-union option.
const WorkspaceSharedTabTargetSchema = z.union([
  BuiltinSharedTabTargetSchema,
  PluginSharedTabTargetSchema,
]);

const builtinTabKinds: ReadonlySet<string> = new Set(
  BuiltinSharedTabTargetSchema.options.map((option) => option.shape.kind.value),
);
const pluginTabContexts: ReadonlySet<string> = new Set(
  PluginSharedTabTargetSchema.options.map((option) => option.shape.context.value),
);

export function isUnknownWorkspaceSharedTabTarget(target: Record<string, unknown>) {
  if (target.kind === pluginTarget.kind.value) {
    return (
      typeof target.context === "string" &&
      target.context.length > 0 &&
      !pluginTabContexts.has(target.context)
    );
  }
  return (
    typeof target.kind === "string" && target.kind.length > 0 && !builtinTabKinds.has(target.kind)
  );
}

const SharedTabSchema = z.strictObject({
  tabId: id,
  target: WorkspaceSharedTabTargetSchema,
});

export const WorkspaceSharedSplitSchema = z.strictObject({
  rootId: id,
  // A flat tree keeps the inbound schema compatible with the generated validator.
  nodes: z
    .array(
      z.discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("pane"), id, tabIds: ids }),
        z.strictObject({
          kind: z.literal("group"),
          id,
          direction: z.enum(["horizontal", "vertical"]),
          childIds: z.array(id).min(2).max(16),
          sizes: z.array(z.number().positive()).min(2).max(16),
        }),
      ]),
    )
    .min(1)
    .max(64),
});

const WorkspaceTabLayoutSchema = z.strictObject({
  tabs: z.array(SharedTabSchema).max(MAX_WORKSPACE_SHARED_TABS),
  hiddenAgentIds: ids,
  pinnedAgentIds: ids,
  split: WorkspaceSharedSplitSchema.optional(),
});

export const WorkspaceTabLayoutStateSchema = WorkspaceTabLayoutSchema.extend({
  revision: z.number().int().nonnegative(),
});

const TabPosition = { after: id.optional(), before: id.optional() };

const WorkspaceTabLayoutOperationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("open"), tab: SharedTabSchema, ...TabPosition }),
  z.strictObject({ kind: z.literal("close"), tabId: id }),
  z.strictObject({ kind: z.literal("move"), tabId: id, ...TabPosition }),
  z.strictObject({ kind: z.literal("hide"), agentId: id, hidden: z.boolean() }),
  z.strictObject({ kind: z.literal("pin"), agentId: id, pinned: z.boolean() }),
  z.strictObject({
    kind: z.literal("split"),
    split: WorkspaceSharedSplitSchema,
    ifMissing: z.boolean().optional(),
  }),
]);

export const WorkspaceTabLayoutApplyRequestSchema = z.object({
  type: z.literal("workspace.tabs.apply.request"),
  workspaceId: id,
  requestId: id,
  desktop: z.boolean(),
  seed: WorkspaceTabLayoutSchema.optional(),
  operations: z.array(WorkspaceTabLayoutOperationSchema).max(4096),
});

export const WorkspaceTabLayoutApplyResponseSchema = z.object({
  type: z.literal("workspace.tabs.apply.response"),
  payload: z.object({
    requestId: id,
    state: WorkspaceTabLayoutStateSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export type WorkspaceSharedTab = z.infer<typeof SharedTabSchema>;
export type WorkspaceSharedSplit = z.infer<typeof WorkspaceSharedSplitSchema>;
export type WorkspaceTabLayout = z.infer<typeof WorkspaceTabLayoutSchema>;
export type WorkspaceTabLayoutState = z.infer<typeof WorkspaceTabLayoutStateSchema>;
export type WorkspaceTabLayoutOperation = z.infer<typeof WorkspaceTabLayoutOperationSchema>;

export function syncsWorkspaceSplits(mode: WorkspaceSplitSyncMode, desktop: boolean): boolean {
  return mode === "all" || (mode === "desktop" && desktop);
}

export function isValidWorkspaceSharedSplit(split: WorkspaceSharedSplit): boolean {
  const nodes = new Map(split.nodes.map((node) => [node.id, node]));
  if (nodes.size !== split.nodes.length) return false;
  const visited = new Set<string>();
  const tabIds = new Set<string>();
  function visit(nodeId: string, depth: number): boolean {
    const node = nodes.get(nodeId);
    if (!node || visited.has(nodeId) || depth > 5) return false;
    visited.add(nodeId);
    if (node.kind === "pane") {
      return node.tabIds.every((tabId) => {
        if (tabIds.has(tabId)) return false;
        tabIds.add(tabId);
        return true;
      });
    }
    return (
      node.sizes.length === node.childIds.length &&
      node.childIds.every((childId) => visit(childId, depth + 1))
    );
  }
  return visit(split.rootId, 1) && visited.size === nodes.size;
}

function placeTab(
  tabs: WorkspaceSharedTab[],
  tab: WorkspaceSharedTab,
  position: { after?: string; before?: string },
) {
  const before = tabs.findIndex((entry) => entry.tabId === position.before);
  const after = tabs.findIndex((entry) => entry.tabId === position.after);
  const fallback = after >= 0 ? after + 1 : tabs.length;
  const index = before >= 0 ? before : fallback;
  tabs.splice(index, 0, tab);
}

/** Applies the same relative operations on the daemon and when rebasing pending edits. */
export function applyWorkspaceTabLayoutOperations(
  layout: WorkspaceTabLayout,
  operations: readonly WorkspaceTabLayoutOperation[],
  syncSplits: boolean,
): WorkspaceTabLayout {
  const tabs = [...layout.tabs];
  const hiddenAgentIds = new Set(layout.hiddenAgentIds);
  const pinnedAgentIds = new Set(layout.pinnedAgentIds);
  let split = layout.split;
  for (const operation of operations) {
    switch (operation.kind) {
      case "open":
        if (!tabs.some((tab) => tab.tabId === operation.tab.tabId)) {
          placeTab(tabs, operation.tab, operation);
        }
        break;
      case "close":
      case "move": {
        const index = tabs.findIndex((tab) => tab.tabId === operation.tabId);
        if (index < 0) break;
        const [tab] = tabs.splice(index, 1);
        if (operation.kind === "move") placeTab(tabs, tab, operation);
        break;
      }
      case "hide":
        if (operation.hidden) hiddenAgentIds.add(operation.agentId);
        else hiddenAgentIds.delete(operation.agentId);
        break;
      case "pin":
        if (operation.pinned) pinnedAgentIds.add(operation.agentId);
        else pinnedAgentIds.delete(operation.agentId);
        break;
      case "split":
        if (syncSplits && (!operation.ifMissing || !split)) split = operation.split;
        break;
    }
  }
  return { tabs, hiddenAgentIds: [...hiddenAgentIds], pinnedAgentIds: [...pinnedAgentIds], split };
}
