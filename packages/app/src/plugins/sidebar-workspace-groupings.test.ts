import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORKSPACE_PLACEMENT_LABEL,
  LOGICAL_WORKSPACE_REF_LABEL_PREFIX,
} from "@getpaseo/protocol/workspace-labels";
import type { InstalledPlugin } from "./types";
import { resolvePluginSidebarWorkspaceGroupings } from "./sidebar-workspace-groupings";

function plugin(
  serverId: string,
  input: {
    id?: string;
    logicalWorkspaceRefLabelPrefix?: string;
    defaultPlacementLabel?: string;
    retainedHistoryBindings?: Array<{
      workspaceId: string;
      physicalWorkspaceRef: string;
      logicalWorkspaceRef: string;
    }>;
  } = {},
): InstalledPlugin {
  return {
    id: "paseo-layout",
    serverId,
    sidebarWorkspaceGroupings: [
      {
        id: input.id ?? "logical-workspaces",
        logicalWorkspaceRefLabelPrefix:
          input.logicalWorkspaceRefLabelPrefix ?? LOGICAL_WORKSPACE_REF_LABEL_PREFIX,
        defaultPlacementLabel: input.defaultPlacementLabel ?? DEFAULT_WORKSPACE_PLACEMENT_LABEL,
        retainedHistoryBindings: input.retainedHistoryBindings,
      },
    ],
  } as InstalledPlugin;
}

describe("plugin sidebar workspace groupings", () => {
  it("coalesces the same declarative seam across hosts", () => {
    expect(
      resolvePluginSidebarWorkspaceGroupings([plugin("host-a"), plugin("host-b")]),
    ).toEqual([
      {
        key: "paseo-layout/sidebar-workspace-grouping/logical-workspaces",
        logicalWorkspaceRefLabelPrefix: LOGICAL_WORKSPACE_REF_LABEL_PREFIX,
        defaultPlacementLabel: DEFAULT_WORKSPACE_PLACEMENT_LABEL,
        serverIds: ["host-a", "host-b"],
        retainedHistoryBindings: [],
      },
    ]);
  });

  it("fails open when no plugin contributes the seam", () => {
    expect(resolvePluginSidebarWorkspaceGroupings([])).toEqual([]);
  });

  it("fails open on a cross-host codec conflict instead of choosing by arrival order", () => {
    expect(
      resolvePluginSidebarWorkspaceGroupings([
        plugin("host-a"),
        plugin("host-b", {
          logicalWorkspaceRefLabelPrefix: "paseo:reserved:v2:logical-workspace-ref=",
        }),
      ]),
    ).toEqual([]);
    expect(
      resolvePluginSidebarWorkspaceGroupings([
        plugin("host-b", {
          logicalWorkspaceRefLabelPrefix: "paseo:reserved:v2:logical-workspace-ref=",
        }),
        plugin("host-a"),
      ]),
    ).toEqual([]);
  });

  it("attaches server identity while coalescing host-local retained-history bindings", () => {
    expect(
      resolvePluginSidebarWorkspaceGroupings([
        plugin("host-a"),
        plugin("host-b", {
          retainedHistoryBindings: [
            {
              workspaceId: "wks_retained_history",
              physicalWorkspaceRef: "project-a-catalog-host-b",
              logicalWorkspaceRef: "project-a-catalog",
            },
          ],
        }),
      ]),
    ).toEqual([
      {
        key: "paseo-layout/sidebar-workspace-grouping/logical-workspaces",
        logicalWorkspaceRefLabelPrefix: LOGICAL_WORKSPACE_REF_LABEL_PREFIX,
        defaultPlacementLabel: DEFAULT_WORKSPACE_PLACEMENT_LABEL,
        serverIds: ["host-a", "host-b"],
        retainedHistoryBindings: [
          {
            serverId: "host-b",
            workspaceId: "wks_retained_history",
            physicalWorkspaceRef: "project-a-catalog-host-b",
            logicalWorkspaceRef: "project-a-catalog",
          },
        ],
      },
    ]);
  });

  it("drops only an ambiguous retained-history identity and keeps the codec fail-open", () => {
    expect(
      resolvePluginSidebarWorkspaceGroupings([
        plugin("host-b", {
          retainedHistoryBindings: [
            {
              workspaceId: "old-workspace",
              physicalWorkspaceRef: "project-a-catalog-host-b",
              logicalWorkspaceRef: "project-a-catalog",
            },
          ],
        }),
        plugin("host-b", {
          retainedHistoryBindings: [
            {
              workspaceId: "old-workspace",
              physicalWorkspaceRef: "project-a-catalog-host-b",
              logicalWorkspaceRef: "project-a-diagnostics",
            },
          ],
        }),
      ]),
    ).toEqual([
      {
        key: "paseo-layout/sidebar-workspace-grouping/logical-workspaces",
        logicalWorkspaceRefLabelPrefix: LOGICAL_WORKSPACE_REF_LABEL_PREFIX,
        defaultPlacementLabel: DEFAULT_WORKSPACE_PLACEMENT_LABEL,
        serverIds: ["host-b"],
        retainedHistoryBindings: [],
      },
    ]);
  });
});
