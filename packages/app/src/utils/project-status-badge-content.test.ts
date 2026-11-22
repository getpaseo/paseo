import { describe, expect, it } from "vitest";
import { getProjectStatusBadgeContent } from "./project-status-badge-content";

describe("getProjectStatusBadgeContent", () => {
  it("shows a running dot while working", () => {
    expect(getProjectStatusBadgeContent("running")).toEqual({ kind: "dot", bucket: "running" });
  });

  it("shows the alert when input is needed", () => {
    expect(getProjectStatusBadgeContent("needs_input")).toEqual({ kind: "alert" });
  });

  it("shows a failed dot when a workspace failed", () => {
    expect(getProjectStatusBadgeContent("failed")).toEqual({ kind: "dot", bucket: "failed" });
  });

  it("shows an attention dot when a workspace awaits review", () => {
    expect(getProjectStatusBadgeContent("attention")).toEqual({
      kind: "dot",
      bucket: "attention",
    });
  });

  it("shows nothing when the project is done", () => {
    expect(getProjectStatusBadgeContent("done")).toBeNull();
  });

  it("uses the same dot for a read result that needs follow-up", () => {
    expect(getProjectStatusBadgeContent("needs_follow_up")).toEqual({
      kind: "dot",
      bucket: "needs_follow_up",
    });
  });

  it("shows nothing when there is no aggregate bucket to surface", () => {
    expect(getProjectStatusBadgeContent(null)).toBeNull();
  });
});
