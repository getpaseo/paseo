import { describe, expect, it } from "vitest";
import type { DaemonServerInfo } from "@/stores/session-store";
import { resolveAgentPurposeSummary } from "./purpose-summary";

function serverInfo(agentPurposeSummary?: boolean): DaemonServerInfo {
  return {
    serverId: "server-1",
    hostname: "host",
    version: "0.2.5",
    features: { agentPurposeSummary },
  };
}

describe("resolveAgentPurposeSummary", () => {
  it("returns a normalized summary when the daemon advertises the feature", () => {
    expect(
      resolveAgentPurposeSummary({
        summary: "  Reviewing the state projections  ",
        serverInfo: serverInfo(true),
      }),
    ).toBe("Reviewing the state projections");
  });

  it("hides a summary from a daemon without the capability", () => {
    expect(
      resolveAgentPurposeSummary({
        summary: "Reviewing the state projections",
        serverInfo: serverInfo(false),
      }),
    ).toBeNull();
    expect(
      resolveAgentPurposeSummary({
        summary: "Reviewing the state projections",
        serverInfo: serverInfo(),
      }),
    ).toBeNull();
  });

  it("hides missing and blank summaries", () => {
    expect(resolveAgentPurposeSummary({ summary: null, serverInfo: serverInfo(true) })).toBeNull();
    expect(resolveAgentPurposeSummary({ summary: "   ", serverInfo: serverInfo(true) })).toBeNull();
  });
});
