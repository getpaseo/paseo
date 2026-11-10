import { describe, expect, it } from "vitest";
import { resolveCloseAgentTabConfirmation, resolveCloseAgentTabPolicy } from "./close-tab-policy";

describe("resolveCloseAgentTabPolicy", () => {
  it("archives root agents when their tab closes", () => {
    expect(resolveCloseAgentTabPolicy({ parentAgentId: null })).toEqual({
      kind: "archive-on-close",
    });
  });

  it("keeps subagent tab close layout-only", () => {
    expect(resolveCloseAgentTabPolicy({ parentAgentId: "parent-agent" })).toEqual({
      kind: "layout-only",
    });
  });

  it("preserves the existing archive fallback when the agent is missing", () => {
    expect(resolveCloseAgentTabPolicy(null)).toEqual({ kind: "archive-on-close" });
    expect(resolveCloseAgentTabPolicy(undefined)).toEqual({ kind: "archive-on-close" });
  });
});

describe("resolveCloseAgentTabConfirmation", () => {
  it("asks before archiving a running root agent regardless of the setting", () => {
    const agent = { parentAgentId: null, status: "running" } as const;
    expect(resolveCloseAgentTabConfirmation(agent, { alwaysConfirmArchive: false })).toBe(
      "archive-running-agent",
    );
    expect(resolveCloseAgentTabConfirmation(agent, { alwaysConfirmArchive: true })).toBe(
      "archive-running-agent",
    );
  });

  it("archives an idle root agent without asking by default", () => {
    expect(
      resolveCloseAgentTabConfirmation(
        { parentAgentId: null, status: "idle" },
        { alwaysConfirmArchive: false },
      ),
    ).toBeNull();
  });

  it("asks before archiving an idle root agent when always confirm is on", () => {
    for (const status of ["idle", "error", "closed", "initializing"] as const) {
      expect(
        resolveCloseAgentTabConfirmation(
          { parentAgentId: null, status },
          { alwaysConfirmArchive: true },
        ),
      ).toBe("archive-agent");
    }
  });

  it("never asks when closing a subagent tab, which only changes the layout", () => {
    for (const status of ["running", "idle"] as const) {
      expect(
        resolveCloseAgentTabConfirmation(
          { parentAgentId: "parent-agent", status },
          { alwaysConfirmArchive: true },
        ),
      ).toBeNull();
    }
  });

  it("asks when always confirm is on and the agent snapshot is missing", () => {
    expect(resolveCloseAgentTabConfirmation(null, { alwaysConfirmArchive: true })).toBe(
      "archive-agent",
    );
    expect(resolveCloseAgentTabConfirmation(null, { alwaysConfirmArchive: false })).toBeNull();
  });
});
