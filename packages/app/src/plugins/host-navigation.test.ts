import { describe, expect, it } from "vitest";
import { createPluginHostNavigation } from "./host-navigation-model";
import { resolveNavigateToAgent } from "@/utils/navigate-to-agent/resolve";

describe("plugin host navigation", () => {
  function setup(electron = true) {
    const destinations: unknown[] = [];
    const browsers: string[] = [];
    const workspaces = new Set(["selected:one", "remote:two"]);
    const navigation = createPluginHostNavigation("selected", {
      browserAvailable: electron,
      resolveWorkspace: ({ serverId, workspaceId }) =>
        workspaces.has(`${serverId}:${workspaceId}`) ? workspaceId : null,
      openAgent: (input) => destinations.push(input),
      openWorkspace: (input) => destinations.push(input),
      createBrowser: ({ initialUrl }) => {
        browsers.push(initialUrl);
        return { browserId: `browser-${browsers.length}` };
      },
    });
    return { navigation, destinations, browsers, workspaces };
  }

  it("opens an uncached archived agent directly in its known workspace", () => {
    const workspaces: unknown[] = [];
    const legacyRoutes: string[] = [];
    const navigation = createPluginHostNavigation("selected", {
      browserAvailable: false,
      openAgent: (input) => {
        resolveNavigateToAgent(input, {
          readAgentNavTarget: () => ({ agentWorkspaceId: undefined }),
          navigateToHostAgent: (route) => legacyRoutes.push(route),
          navigateToWorkspace: (target) => {
            workspaces.push(target);
            return "workspace-route";
          },
        });
      },
      openWorkspace: (input) => workspaces.push(input),
      resolveWorkspace: () => null,
      createBrowser: () => ({ browserId: "unused" }),
    });

    navigation.openAgent({ agentId: "archived", workspaceId: "one", pin: true });

    expect(legacyRoutes).toEqual([]);
    expect(workspaces).toEqual([
      {
        serverId: "selected",
        workspaceId: "one",
        target: { kind: "agent", agentId: "archived" },
        pin: true,
      },
    ]);
  });

  it("preserves explicit host, workspace, and false pin values", () => {
    const { navigation, destinations } = setup();
    navigation.openAgent({
      serverId: "remote",
      agentId: "archived",
      workspaceId: "two",
      pin: false,
    });
    expect(destinations).toEqual([
      { serverId: "remote", agentId: "archived", workspaceId: "two", pin: false },
    ]);
  });

  it("keeps existing agent navigation calls unchanged", () => {
    const { navigation, destinations } = setup();
    navigation.openAgent({ agentId: "local-agent" });
    navigation.openAgent({ serverId: "remote", agentId: "remote-agent" });
    expect(destinations).toEqual([
      { serverId: "selected", agentId: "local-agent" },
      { serverId: "remote", agentId: "remote-agent" },
    ]);
  });

  it("creates and focuses a local browser in the selected or explicit host workspace", () => {
    const { navigation, destinations, browsers } = setup();
    navigation.openBrowser!({ url: "https://example.com/one", workspaceId: "one" });
    navigation.openBrowser!({
      url: "https://example.com/two",
      workspaceId: "two",
      serverId: "remote",
    });
    expect(browsers).toEqual(["https://example.com/one", "https://example.com/two"]);
    expect(destinations).toEqual([
      {
        serverId: "selected",
        workspaceId: "one",
        target: { kind: "browser", browserId: "browser-1" },
      },
      {
        serverId: "remote",
        workspaceId: "two",
        target: { kind: "browser", browserId: "browser-2" },
      },
    ]);
  });

  it("refuses unknown or removed workspaces before creating browser records", () => {
    const { navigation, destinations, browsers, workspaces } = setup();
    expect(() =>
      navigation.openBrowser!({ url: "https://example.com", workspaceId: "missing" }),
    ).toThrow("Workspace is unavailable");
    expect(() =>
      navigation.openBrowser!({
        url: "https://example.com",
        workspaceId: "one",
        serverId: "unknown",
      }),
    ).toThrow("Workspace is unavailable");
    workspaces.delete("selected:one");
    expect(() =>
      navigation.openBrowser!({ url: "https://example.com", workspaceId: "one" }),
    ).toThrow("Workspace is unavailable");
    expect(destinations).toEqual([]);
    expect(browsers).toEqual([]);
  });

  it("exposes no browser capability outside Electron and creates no tabs", () => {
    const { navigation, destinations, browsers } = setup(false);
    expect(navigation.openBrowser).toBeUndefined();
    expect(destinations).toEqual([]);
    expect(browsers).toEqual([]);
  });

  it.each(["javascript:alert(1)", "file:///tmp/file", "/relative", "invalid"])(
    "rejects %s before creating a browser",
    (url) => {
      const { navigation, browsers, destinations } = setup();
      expect(() => navigation.openBrowser!({ url, workspaceId: "one" })).toThrow("HTTP(S)");
      expect(browsers).toEqual([]);
      expect(destinations).toEqual([]);
    },
  );

  it("rejects an empty workspace before creating a browser", () => {
    const { navigation, browsers } = setup();
    expect(() => navigation.openBrowser!({ url: "https://example.com", workspaceId: "" })).toThrow(
      "workspaceId",
    );
    expect(browsers).toEqual([]);
  });
});
