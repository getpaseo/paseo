import { describe, expect, it } from "vitest";
import type { DaemonServerInfo } from "@/stores/session-store";
import { hostSupportsOpenCodeSessionDiff } from "@/runtime/opencode-session-diff";

function serverInfo(features: DaemonServerInfo["features"]): DaemonServerInfo {
  return {
    serverId: "server-1",
    hostname: "host",
    version: "0.2.0",
    features,
  };
}

describe("hostSupportsOpenCodeSessionDiff", () => {
  it("reports supported when the daemon advertises the capability", () => {
    expect(hostSupportsOpenCodeSessionDiff(serverInfo({ opencodeSessionDiff: true }))).toBe(true);
  });

  it("reports unsupported when the flag is explicitly false", () => {
    expect(hostSupportsOpenCodeSessionDiff(serverInfo({ opencodeSessionDiff: false }))).toBe(false);
  });

  it("reports unsupported when the flag is absent (old daemon)", () => {
    expect(hostSupportsOpenCodeSessionDiff(serverInfo({}))).toBe(false);
    expect(hostSupportsOpenCodeSessionDiff(serverInfo(undefined))).toBe(false);
  });

  it("reports unsupported when there is no server info yet", () => {
    expect(hostSupportsOpenCodeSessionDiff(null)).toBe(false);
    expect(hostSupportsOpenCodeSessionDiff(undefined)).toBe(false);
  });
});
