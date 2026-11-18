import { describe, expect, it } from "vitest";
import { resolveCloseAgentTabPolicy } from "./close-tab-policy";

describe("resolveCloseAgentTabPolicy", () => {
  it("archives an idle root agent without asking", () => {
    expect(
      resolveCloseAgentTabPolicy({
        parentAgentId: null,
        status: "idle",
        backgroundWork: { count: 0 },
      }),
    ).toEqual({ kind: "archive-on-close", confirmArchive: false });
  });

  it("asks before archiving a running root agent", () => {
    expect(resolveCloseAgentTabPolicy({ parentAgentId: null, status: "running" })).toEqual({
      kind: "archive-on-close",
      confirmArchive: true,
    });
  });

  it("asks before archiving a root agent whose turn ended while background work still runs", () => {
    expect(
      resolveCloseAgentTabPolicy({
        parentAgentId: null,
        status: "idle",
        backgroundWork: { count: 1 },
      }),
    ).toEqual({ kind: "archive-on-close", confirmArchive: true });
  });

  it("keeps subagent tab close layout-only", () => {
    expect(
      resolveCloseAgentTabPolicy({
        parentAgentId: "parent-agent",
        status: "running",
        backgroundWork: { count: 1 },
      }),
    ).toEqual({ kind: "layout-only" });
  });

  it("preserves the existing archive fallback when the agent is missing", () => {
    expect(resolveCloseAgentTabPolicy(null)).toEqual({
      kind: "archive-on-close",
      confirmArchive: false,
    });
    expect(resolveCloseAgentTabPolicy(undefined)).toEqual({
      kind: "archive-on-close",
      confirmArchive: false,
    });
  });
});
