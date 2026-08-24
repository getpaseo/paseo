import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORKSPACE_PLACEMENT_LABEL,
  LOGICAL_WORKSPACE_REF_LABEL_PREFIX,
} from "@getpaseo/protocol/workspace-labels";
import type { PluginSidebarWorkspaceGrouping } from "@/plugins/sidebar-workspace-groupings";
import {
  NEW_LOGICAL_WORKSPACE_OPTION_ID,
  buildInitialLogicalWorkspaceLabels,
  buildLogicalWorkspaceOptions,
  buildLogicalWorkspaceSelectionScopeKey,
  resolveLogicalWorkspaceCreationGrouping,
  resolveLogicalWorkspaceRefOption,
} from "./logical-workspace-selection";

const grouping: PluginSidebarWorkspaceGrouping = {
  key: "paseo-layout/sidebar-workspace-grouping/logical-workspaces",
  logicalWorkspaceRefLabelPrefix: LOGICAL_WORKSPACE_REF_LABEL_PREFIX,
  defaultPlacementLabel: DEFAULT_WORKSPACE_PLACEMENT_LABEL,
  serverIds: ["mac", "nuc"],
};

describe("new workspace logical grouping", () => {
  it("uses the one grouping installed for the selected host and fails open on ambiguity", () => {
    expect(resolveLogicalWorkspaceCreationGrouping([grouping], "nuc")).toBe(grouping);
    expect(resolveLogicalWorkspaceCreationGrouping([grouping], "vps")).toBeNull();
    expect(
      resolveLogicalWorkspaceCreationGrouping(
        [grouping, { ...grouping, key: "other/logical" }],
        "nuc",
      ),
    ).toBeNull();
  });

  it("lists each logical workspace once and takes its title from the default placement", () => {
    const options = buildLogicalWorkspaceOptions({
      grouping,
      workspaces: [
        {
          workspaceKey: "nuc:parts",
          serverId: "nuc",
          name: "parts-nuc",
          title: "Części i katalogi",
          labels: [`${LOGICAL_WORKSPACE_REF_LABEL_PREFIX}cars-parts`],
        },
        {
          workspaceKey: "mac:parts",
          serverId: "mac",
          name: "parts-mac",
          title: "Części i katalogi",
          labels: [
            `${LOGICAL_WORKSPACE_REF_LABEL_PREFIX}cars-parts`,
            DEFAULT_WORKSPACE_PLACEMENT_LABEL,
          ],
        },
        {
          workspaceKey: "nuc:diagnostics",
          serverId: "nuc",
          name: "Diagnostyka",
          title: null,
          labels: [
            `${LOGICAL_WORKSPACE_REF_LABEL_PREFIX}cars-diagnostics`,
            DEFAULT_WORKSPACE_PLACEMENT_LABEL,
          ],
        },
      ],
    });

    expect(options).toEqual([
      {
        logicalWorkspaceRef: "cars-parts",
        title: "Części i katalogi",
        serverIds: ["mac", "nuc"],
      },
      {
        logicalWorkspaceRef: "cars-diagnostics",
        title: "Diagnostyka",
        serverIds: ["nuc"],
      },
    ]);
  });

  it("marks only a newly-created logical workspace placement as the default", () => {
    expect(
      buildInitialLogicalWorkspaceLabels({
        grouping,
        selection: { kind: "new", logicalWorkspaceRef: "lw-new" },
      }),
    ).toEqual([`${LOGICAL_WORKSPACE_REF_LABEL_PREFIX}lw-new`, DEFAULT_WORKSPACE_PLACEMENT_LABEL]);
    expect(
      buildInitialLogicalWorkspaceLabels({
        grouping,
        selection: { kind: "existing", logicalWorkspaceRef: "cars-parts" },
      }),
    ).toEqual([`${LOGICAL_WORKSPACE_REF_LABEL_PREFIX}cars-parts`]);
  });

  it("fails open when a logical workspace ref from the route is invalid", () => {
    expect(
      buildInitialLogicalWorkspaceLabels({
        grouping,
        selection: { kind: "existing", logicalWorkspaceRef: "invalid ref with spaces" },
      }),
    ).toBeUndefined();
  });

  it("keeps the legal logical ref 'new' distinct from the new-workspace sentinel", () => {
    expect(resolveLogicalWorkspaceRefOption("new")).toBe("new");
    expect(resolveLogicalWorkspaceRefOption(NEW_LOGICAL_WORKSPACE_OPTION_ID)).toBeNull();
  });

  it("scopes a selection to both the native project and plugin namespace", () => {
    expect(buildLogicalWorkspaceSelectionScopeKey("project-a", grouping)).toBe(
      JSON.stringify(["project-a", grouping.key]),
    );
    expect(
      buildLogicalWorkspaceSelectionScopeKey("project-a", {
        ...grouping,
        key: "another/sidebar-workspace-grouping/logical-workspaces",
      }),
    ).not.toBe(buildLogicalWorkspaceSelectionScopeKey("project-a", grouping));
    expect(buildLogicalWorkspaceSelectionScopeKey(null, grouping)).toBeNull();
    expect(buildLogicalWorkspaceSelectionScopeKey("project-a", null)).toBeNull();
  });
});
