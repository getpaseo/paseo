import { describe, expect, it, vi } from "vitest";
import { createPluginNavigation, type PluginNavigationDeps } from "./navigation";

function deps() {
  return {
    navigateToWorkspace: vi.fn(() => "/workspace-route"),
    navigateToAgent: vi.fn(() => "/agent-route"),
    openExternalUrl: vi.fn(async () => undefined),
  } as unknown as PluginNavigationDeps & {
    navigateToWorkspace: ReturnType<typeof vi.fn>;
    navigateToAgent: ReturnType<typeof vi.fn>;
    openExternalUrl: ReturnType<typeof vi.fn>;
  };
}

describe("createPluginNavigation", () => {
  it("opens a workspace on the plugin's own host", () => {
    const spies = deps();
    createPluginNavigation("host-a", spies).openWorkspace("workspace-1");

    expect(spies.navigateToWorkspace).toHaveBeenCalledWith({
      serverId: "host-a",
      workspaceId: "workspace-1",
    });
    expect(spies.navigateToAgent).not.toHaveBeenCalled();
  });

  it("focuses and pins an agent when one is named", () => {
    const spies = deps();
    createPluginNavigation("host-a", spies).openWorkspace("workspace-1", { agentId: "agent-1" });

    expect(spies.navigateToAgent).toHaveBeenCalledWith({
      serverId: "host-a",
      agentId: "agent-1",
      workspaceId: "workspace-1",
      pin: true,
    });
    expect(spies.navigateToWorkspace).not.toHaveBeenCalled();
  });

  it("honours an explicit pin choice", () => {
    const spies = deps();
    createPluginNavigation("host-a", spies).openWorkspace("workspace-1", {
      agentId: "agent-1",
      pin: false,
    });

    expect(spies.navigateToAgent).toHaveBeenCalledWith(expect.objectContaining({ pin: false }));
  });

  it("opens a workspace on an explicitly selected host", () => {
    const spies = deps();
    createPluginNavigation("host-a", spies).openWorkspace("workspace-1", {
      agentId: "agent-1",
      serverId: "host-b",
    });

    expect(spies.navigateToAgent).toHaveBeenCalledWith({
      serverId: "host-b",
      agentId: "agent-1",
      workspaceId: "workspace-1",
      pin: true,
    });
  });

  it("rejects a blank workspace id instead of navigating somewhere arbitrary", () => {
    const spies = deps();
    expect(() => createPluginNavigation("host-a", spies).openWorkspace("  ")).toThrow(
      /workspace id/,
    );
    expect(spies.navigateToWorkspace).not.toHaveBeenCalled();
  });

  it("hands an http(s) URL to the OS browser", async () => {
    const spies = deps();
    await createPluginNavigation("host-a", spies).openExternal(
      "https://github.com/acme/api/pull/7",
    );

    expect(spies.openExternalUrl).toHaveBeenCalledWith("https://github.com/acme/api/pull/7");
  });

  it("refuses a scheme the browser opener would silently drop", async () => {
    const spies = deps();
    const navigation = createPluginNavigation("host-a", spies);

    await expect(navigation.openExternal("file:///etc/passwd")).rejects.toThrow(/http\(s\)/);
    await expect(navigation.openExternal("not a url")).rejects.toThrow(/absolute URL/);
    expect(spies.openExternalUrl).not.toHaveBeenCalled();
  });
});
