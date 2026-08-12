import { describe, expect, it } from "vitest";
import { resolveCloseAgentTabPolicy } from "./close-tab-policy";

describe("resolveCloseAgentTabPolicy", () => {
  it("keeps root agent tab close layout-only", () => {
    expect(resolveCloseAgentTabPolicy({ parentAgentId: null })).toEqual({
      kind: "layout-only",
    });
  });

  it("keeps subagent tab close layout-only", () => {
    expect(resolveCloseAgentTabPolicy({ parentAgentId: "parent-agent" })).toEqual({
      kind: "layout-only",
    });
  });

  it("keeps tab close layout-only when the agent is missing", () => {
    expect(resolveCloseAgentTabPolicy(null)).toEqual({ kind: "layout-only" });
    expect(resolveCloseAgentTabPolicy(undefined)).toEqual({ kind: "layout-only" });
  });
});
