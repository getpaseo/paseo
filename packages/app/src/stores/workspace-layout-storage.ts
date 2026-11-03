import { z } from "zod";
import type { SplitNode, WorkspaceLayout } from "./workspace-layout-actions";

const WorkspaceDraftTabSetupStorageSchema = z.strictObject({
  provider: z.string(),
  cwd: z.string(),
  modeId: z.string().nullable(),
  model: z.string().nullable(),
  thinkingOptionId: z.string().nullable(),
  featureValues: z.record(z.string(), z.union([z.boolean(), z.string(), z.null()])),
});
const WorkspaceTabTargetStorageSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("new_tab") }),
  z.strictObject({
    kind: z.literal("draft"),
    draftId: z.string(),
    setup: WorkspaceDraftTabSetupStorageSchema.optional(),
  }),
  z.strictObject({ kind: z.literal("agent"), agentId: z.string() }),
  z.strictObject({
    kind: z.literal("provider_subagent"),
    parentAgentId: z.string(),
    subagentId: z.string(),
  }),
  z.strictObject({ kind: z.literal("terminal"), terminalId: z.string() }),
  z.strictObject({ kind: z.literal("browser"), browserId: z.string() }),
  z.strictObject({ kind: z.literal("changes_tree") }),
  z.strictObject({ kind: z.literal("files") }),
  z.strictObject({ kind: z.literal("pull_request") }),
  z.strictObject({
    kind: z.literal("file"),
    path: z.string(),
    lineStart: z.number().int().positive().optional(),
    lineEnd: z.number().int().positive().optional(),
  }),
  z.strictObject({
    kind: z.literal("working_diff"),
    focusPath: z.string().optional(),
    focusRequestId: z.number().optional(),
    // COMPAT(workingDiffTarget): accepted from pre-canonical tab ids; normalization removes them.
    mode: z.enum(["uncommitted", "base"]).optional(),
    baseRef: z.string().nullable().optional(),
    ignoreWhitespace: z.boolean().optional(),
  }),
  z.strictObject({ kind: z.literal("setup"), workspaceId: z.string() }),
  z.strictObject({ kind: z.literal("commit_diff"), sha: z.string() }),
  z.discriminatedUnion("context", [
    z.strictObject({
      kind: z.literal("plugin"),
      pluginId: z.string(),
      panelId: z.string(),
      context: z.literal("workspace"),
    }),
    z.strictObject({
      kind: z.literal("plugin"),
      pluginId: z.string(),
      panelId: z.string(),
      context: z.literal("agent"),
      agentId: z.string(),
    }),
  ]),
]);
const WorkspaceTabStorageSchema = z.strictObject({
  tabId: z.string(),
  target: WorkspaceTabTargetStorageSchema,
  createdAt: z.number(),
  state: z.json().optional(),
});
const SplitNodeStorageSchema: z.ZodType<SplitNode> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("pane"),
      pane: z.strictObject({
        id: z.string(),
        tabIds: z.array(z.string()),
        focusedTabId: z.string().nullable(),
        tabs: z.array(WorkspaceTabStorageSchema).optional(),
        hidden: z.boolean().optional(),
      }),
    }),
    z.strictObject({
      kind: z.literal("group"),
      group: z.strictObject({
        id: z.string(),
        direction: z.enum(["horizontal", "vertical"]),
        children: z.array(SplitNodeStorageSchema),
        sizes: z.array(z.number()),
      }),
    }),
  ]),
);
const WorkspaceLayoutStorageSchema: z.ZodType<WorkspaceLayout> = z.strictObject({
  root: SplitNodeStorageSchema,
  focusedPaneId: z.string().nullable(),
  parentTabIdByTabId: z.record(z.string(), z.string()).optional(),
});
export const WorkspaceLayoutPersistedStateSchema = z.strictObject({
  pinnedAgentIdsByWorkspace: z.record(z.string(), z.array(z.string())).optional(),
  layoutByWorkspace: z.record(z.string(), WorkspaceLayoutStorageSchema),
  splitSizesByWorkspace: z.record(z.string(), z.record(z.string(), z.array(z.number()))).optional(),
  explorerSidebarWidthByWorkspace: z.record(z.string(), z.number()).optional(),
  // COMPAT(explorerSidebarWidth): added in v0.6, remove after 2027-08-25.
  explorerSidebarRatioByWorkspace: z.record(z.string(), z.number()).optional(),
  // COMPAT(explorerSidebarNaming): accepted from builds that called this dock the Side panel.
  sidePanelRatioByWorkspace: z.record(z.string(), z.number()).optional(),
  // The persisted keys keep their pre-rename spelling: the schema is strict, so a
  // rename here would fail every existing blob and wipe the layout it describes.
  explorerPaneIdByWorkspace: z.record(z.string(), z.string().nullable()).optional(),
  explorerSidebarPaneIdByWorkspace: z.record(z.string(), z.string().nullable()).optional(),
  sidePaneIdByWorkspace: z.record(z.string(), z.string().nullable()).optional(),
  bottomPaneIdByWorkspace: z.record(z.string(), z.string().nullable()).optional(),
  pullRequestTabAutoOpenedByWorkspace: z.record(z.string(), z.literal(true)).optional(),
  // COMPAT(pullRequestAutoAdd): PR detection stopped opening a tab in v0.5; accepted
  // and ignored so upgrading does not discard the layout. Remove after 2027-08-20.
  acknowledgedPullRequestByWorkspace: z.record(z.string(), z.string()).optional(),
});
