import { describe, expect, it } from "vitest";
import { parseWorkspaceRouteUrl } from "./workspace-route-url.js";

describe("parseWorkspaceRouteUrl", () => {
  it("parses a packaged paseo:// workspace route", () => {
    expect(parseWorkspaceRouteUrl("paseo://app/h/local/workspace/abc123")).toEqual({
      serverId: "local",
      workspaceId: "abc123",
    });
  });

  it("parses a dev-server workspace route", () => {
    expect(parseWorkspaceRouteUrl("http://localhost:8081/h/local/workspace/abc123")).toEqual({
      serverId: "local",
      workspaceId: "abc123",
    });
  });

  it("parses a workspace route with a trailing slash", () => {
    expect(parseWorkspaceRouteUrl("paseo://app/h/local/workspace/abc123/")).toEqual({
      serverId: "local",
      workspaceId: "abc123",
    });
  });

  it("decodes percent-encoded ids", () => {
    expect(parseWorkspaceRouteUrl("paseo://app/h/remote%3Agithub.com/workspace/ws%2Fone")).toEqual({
      serverId: "remote:github.com",
      workspaceId: "ws/one",
    });
  });

  it("ignores query and hash", () => {
    expect(parseWorkspaceRouteUrl("paseo://app/h/local/workspace/abc123?tab=files#top")).toEqual({
      serverId: "local",
      workspaceId: "abc123",
    });
  });

  it("returns null for non-workspace routes", () => {
    expect(parseWorkspaceRouteUrl("paseo://app/h/local/agent/abc123")).toBeNull();
    expect(parseWorkspaceRouteUrl("paseo://app/")).toBeNull();
    expect(parseWorkspaceRouteUrl("paseo://app/h/local/workspace/")).toBeNull();
  });

  it("returns null for a malformed URL", () => {
    expect(parseWorkspaceRouteUrl("not a url")).toBeNull();
  });
});
