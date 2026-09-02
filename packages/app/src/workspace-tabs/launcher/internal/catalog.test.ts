import { describe, expect, it } from "vitest";
import { getBuiltInLaunchOrder, getPluginPanelLaunchEntries } from "./catalog";

describe("getBuiltInLaunchOrder", () => {
  it("leads with creating work in a primary pane", () => {
    expect(getBuiltInLaunchOrder("primary")).toEqual([
      "agent",
      "terminal",
      "changes",
      "diff",
      "files",
      "browser",
      "pullRequest",
    ]);
  });

  it("leads with companion tools in a supporting pane", () => {
    expect(getBuiltInLaunchOrder("supporting")).toEqual([
      "changes",
      "diff",
      "files",
      "terminal",
      "agent",
      "browser",
      "pullRequest",
    ]);
  });
});

describe("getPluginPanelLaunchEntries", () => {
  it("binds an Explorer-compatible agent panel to the focused agent", () => {
    const plugins = [
      {
        id: "agent-crew",
        serverId: "host-1",
        workspacePanels: [
          {
            id: "crew",
            title: "Agent Crew",
            icon: "Network",
            context: "agent",
            locations: ["explorer"],
            Component: () => null,
          },
        ],
      },
    ] as const;

    expect(
      getPluginPanelLaunchEntries({
        plugins,
        serverId: "host-1",
        host: "explorer",
        agentId: "agent-1",
      }).map(({ pluginId, panel, target }) => ({ pluginId, panelId: panel.id, target })),
    ).toEqual([
      {
        pluginId: "agent-crew",
        panelId: "crew",
        target: {
          kind: "plugin",
          pluginId: "agent-crew",
          panelId: "crew",
          context: "agent",
          agentId: "agent-1",
        },
      },
    ]);
    expect(
      getPluginPanelLaunchEntries({
        plugins,
        serverId: "host-1",
        host: "explorer",
        agentId: null,
      }),
    ).toEqual([]);
  });
});
