import { describe, expect, it } from "vitest";
import {
  deriveMacDockBadgeCountFromWorkspaceStatuses,
  isWorkspaceActionableForDesktopBadge,
} from "./desktop-badge-state";

describe("desktop-badge-state", () => {
  it("treats attention-requiring workspace statuses as actionable", () => {
    expect(isWorkspaceActionableForDesktopBadge("attention")).toBe(true);
    expect(isWorkspaceActionableForDesktopBadge("needs_input")).toBe(true);
    expect(isWorkspaceActionableForDesktopBadge("failed")).toBe(true);
  });

  it("ignores running and done workspace statuses", () => {
    expect(isWorkspaceActionableForDesktopBadge("running")).toBe(false);
    expect(isWorkspaceActionableForDesktopBadge("done")).toBe(false);
  });

  it("returns undefined when no visible workspaces need attention", () => {
    expect(deriveMacDockBadgeCountFromWorkspaceStatuses(["done", "running"])).toBeUndefined();
  });

  it("counts only actionable visible workspaces", () => {
    expect(
      deriveMacDockBadgeCountFromWorkspaceStatuses([
        "done",
        "attention",
        "running",
        "needs_input",
        "failed",
      ]),
    ).toBe(3);
  });
});
