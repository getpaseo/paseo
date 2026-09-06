import { describe, expect, it } from "vitest";
import {
  buildLiveActivityHeroDeepLink,
  buildLiveActivityPermissionPrimaryDeepLink,
  buildLiveActivityPermissionReviewDeepLink,
  parseLiveActivityDeepLink,
} from "./deep-link";

const TARGET = { serverId: "server-1", agentId: "agent-1" };

describe("buildLiveActivityHeroDeepLink", () => {
  it("targets the hero agent with only the source query param", () => {
    const link = buildLiveActivityHeroDeepLink(TARGET);
    expect(link).toBe("paseo://h/server-1/agent/agent-1?source=live-activity");
  });

  it("percent-encodes serverId and agentId segments", () => {
    const link = buildLiveActivityHeroDeepLink({ serverId: "server/main", agentId: "agent 123" });
    expect(link).toBe("paseo://h/server%2Fmain/agent/agent%20123?source=live-activity");
  });
});

describe("buildLiveActivityPermissionReviewDeepLink", () => {
  it("adds permissionRequestId to the base link", () => {
    const link = buildLiveActivityPermissionReviewDeepLink({
      ...TARGET,
      permissionRequestId: "req-1",
    });
    expect(link).toBe(
      "paseo://h/server-1/agent/agent-1?source=live-activity&permissionRequestId=req-1",
    );
  });
});

describe("buildLiveActivityPermissionPrimaryDeepLink", () => {
  it("adds permissionRequestId and permissionActionId to the base link", () => {
    const link = buildLiveActivityPermissionPrimaryDeepLink({
      ...TARGET,
      permissionRequestId: "req-1",
      permissionActionId: "accept",
    });
    expect(link).toBe(
      "paseo://h/server-1/agent/agent-1?source=live-activity&permissionRequestId=req-1&permissionActionId=accept",
    );
  });
});

describe("parseLiveActivityDeepLink", () => {
  it("round-trips a hero link built by buildLiveActivityHeroDeepLink", () => {
    const link = buildLiveActivityHeroDeepLink(TARGET);
    expect(parseLiveActivityDeepLink(link)).toEqual({
      serverId: "server-1",
      agentId: "agent-1",
      source: "live-activity",
      permissionRequestId: null,
      permissionActionId: null,
    });
  });

  it("round-trips a permission primary link, decoding percent-encoded segments", () => {
    const link = buildLiveActivityPermissionPrimaryDeepLink({
      serverId: "server/main",
      agentId: "agent 123",
      permissionRequestId: "req-1",
      permissionActionId: "accept",
    });
    expect(parseLiveActivityDeepLink(link)).toEqual({
      serverId: "server/main",
      agentId: "agent 123",
      source: "live-activity",
      permissionRequestId: "req-1",
      permissionActionId: "accept",
    });
  });

  it("returns null for a non-paseo URL", () => {
    expect(parseLiveActivityDeepLink("https://h/server-1/agent/agent-1")).toBeNull();
  });

  it("returns null for a malformed input", () => {
    expect(parseLiveActivityDeepLink("not a url")).toBeNull();
  });

  it("returns null when the path is missing the agent segment", () => {
    expect(parseLiveActivityDeepLink("paseo://h/server-1/workspace/w1")).toBeNull();
  });
});
