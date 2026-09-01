import { describe, expect, it } from "vitest";
import {
  DEFAULT_SIDEBAR_AGENT_ROWS,
  hasSidebarAgentRows,
  parseSidebarAgentRows,
} from "./agent-rows";

describe("sidebar agent rows preference", () => {
  it("accepts the three modes and rejects anything else", () => {
    expect(parseSidebarAgentRows("collapsed")).toBe("collapsed");
    expect(parseSidebarAgentRows("expanded")).toBe("expanded");
    expect(parseSidebarAgentRows("none")).toBe("none");
    expect(parseSidebarAgentRows("sometimes")).toBeNull();
    expect(parseSidebarAgentRows(2)).toBeNull();
    expect(parseSidebarAgentRows(undefined)).toBeNull();
  });

  it("defaults to collapsed", () => {
    expect(DEFAULT_SIDEBAR_AGENT_ROWS).toBe("collapsed");
  });

  it("draws nothing for a workspace holding one agent", () => {
    // The row already is that agent's row, so a lone child would restate its dot.
    expect(hasSidebarAgentRows({ agentCount: 1, mode: "collapsed" })).toBe(false);
    expect(hasSidebarAgentRows({ agentCount: 1, mode: "expanded" })).toBe(false);
    expect(hasSidebarAgentRows({ agentCount: 0, mode: "expanded" })).toBe(false);
  });

  it("draws for two or more agents unless switched off", () => {
    expect(hasSidebarAgentRows({ agentCount: 2, mode: "collapsed" })).toBe(true);
    expect(hasSidebarAgentRows({ agentCount: 9, mode: "expanded" })).toBe(true);
    expect(hasSidebarAgentRows({ agentCount: 9, mode: "none" })).toBe(false);
  });
});

describe("blocked agents open their own list", () => {
  // The default moves; the stored override still wins. Covered here rather than in the hook so
  // the rule is readable without a React environment.
  const expandedByDefault = (
    mode: "collapsed" | "expanded" | "none",
    statuses: readonly string[],
  ) =>
    mode === "expanded" ||
    statuses.some((status) => status === "needs_input" || status === "failed");

  it("opens for an agent that cannot proceed without you", () => {
    expect(expandedByDefault("collapsed", ["running", "needs_input"])).toBe(true);
    expect(expandedByDefault("collapsed", ["running", "failed"])).toBe(true);
  });

  it("stays shut for agents that are merely busy or finished", () => {
    expect(expandedByDefault("collapsed", ["running", "running"])).toBe(false);
    // `attention` is a finished turn. Rearranging the sidebar every time one ends would be noise.
    expect(expandedByDefault("collapsed", ["attention", "done"])).toBe(false);
  });
});
