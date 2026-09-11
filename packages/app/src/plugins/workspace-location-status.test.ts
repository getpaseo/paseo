import { describe, expect, it } from "vitest";
import {
  aggregateWorkspaceLocationStatuses,
  resolvePluginWorkspaceLocationStatus,
} from "./workspace-location-status";

describe("workspace location status", () => {
  it("uses the first provider that owns the workspace", async () => {
    const status = await resolvePluginWorkspaceLocationStatus({
      serverId: "host",
      workspaceId: "workspace",
      providers: [
        {
          pluginId: "first",
          provider: { id: "remote", getStatus: async () => null },
        },
        {
          pluginId: "second",
          provider: {
            id: "remote",
            getStatus: async ({ workspaceId }) => ({
              state: "online",
              detail: `Connected to ${workspaceId}`,
            }),
          },
        },
      ],
    });

    expect(status).toEqual({ state: "online", detail: "Connected to workspace" });
  });

  it("keeps checking after a provider fails to identify the workspace", async () => {
    const status = await resolvePluginWorkspaceLocationStatus({
      serverId: "host",
      workspaceId: "workspace",
      providers: [
        {
          pluginId: "broken",
          provider: {
            id: "remote",
            getStatus: async () => {
              throw new Error("probe failed");
            },
          },
        },
        {
          pluginId: "owner",
          provider: { id: "remote", getStatus: async () => ({ state: "offline" }) },
        },
      ],
    });

    expect(status).toEqual({ state: "offline" });
  });

  it("surfaces the first failure when no provider owns the workspace", async () => {
    const status = await resolvePluginWorkspaceLocationStatus({
      serverId: "host",
      workspaceId: "workspace",
      providers: [
        {
          pluginId: "broken",
          provider: {
            id: "remote",
            getStatus: async () => {
              throw new Error("probe failed");
            },
          },
        },
      ],
    });

    expect(status).toEqual({ state: "error", detail: "broken/remote: probe failed" });
  });

  it("treats any available placement as an available project", () => {
    expect(aggregateWorkspaceLocationStatuses([{ state: "offline" }, { state: "online" }])).toEqual(
      { state: "online" },
    );
    expect(
      aggregateWorkspaceLocationStatuses([{ state: "error" }, { state: "connecting" }]),
    ).toEqual({ state: "connecting" });
  });
});
