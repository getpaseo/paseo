import { describe, expect, it } from "vitest";
import { resolveCloseAgentTabPolicy } from "./close-tab-policy";

function rootAgent(overrides: Partial<Parameters<typeof resolveCloseAgentTabPolicy>[0]> = {}) {
  return { parentAgentId: null, status: "idle" as const, ...overrides };
}

describe("resolveCloseAgentTabPolicy", () => {
  it("archives an idle root agent without asking", () => {
    expect(resolveCloseAgentTabPolicy(rootAgent())).toEqual({
      kind: "archive-on-close",
      confirmArchive: false,
    });
  });

  it("asks before archiving a running root agent", () => {
    expect(resolveCloseAgentTabPolicy(rootAgent({ status: "running" }))).toEqual({
      kind: "archive-on-close",
      confirmArchive: true,
    });
  });

  it("asks before archiving a root agent whose turn ended while background work still runs", () => {
    expect(resolveCloseAgentTabPolicy(rootAgent({ backgroundWork: { count: 1 } }))).toEqual({
      kind: "archive-on-close",
      confirmArchive: true,
    });
  });

  it("asks before archiving a root agent whose turn ended while its background subagent still runs", () => {
    expect(
      resolveCloseAgentTabPolicy(rootAgent({ runningProviderSubagents: { count: 1 } })),
    ).toEqual({ kind: "archive-on-close", confirmArchive: true });
  });

  it("keeps subagent tab close layout-only", () => {
    expect(
      resolveCloseAgentTabPolicy(rootAgent({ parentAgentId: "parent-agent", status: "running" })),
    ).toEqual({ kind: "layout-only" });
  });

  it("preserves the existing archive fallback when the agent is missing", () => {
    expect(resolveCloseAgentTabPolicy(null)).toEqual({
      kind: "archive-on-close",
      confirmArchive: false,
    });
  });
});
