import { describe, expect, it } from "vitest";
import { getProjectStatusBadgeContent } from "./project-status-badge-content";

describe("getProjectStatusBadgeContent", () => {
  it("shows the activity grid while working", () => {
    expect(getProjectStatusBadgeContent("running")).toEqual({ kind: "grid", bucket: "running" });
  });

  it("shows the orange pulse when input is needed", () => {
    expect(getProjectStatusBadgeContent("needs_input")).toEqual({
      kind: "pulse",
      bucket: "needs_input",
    });
  });

  it("shows a failed dot when a workspace failed", () => {
    expect(getProjectStatusBadgeContent("failed")).toEqual({ kind: "dot", bucket: "failed" });
  });

  it("shows the green pulse when a workspace awaits review", () => {
    expect(getProjectStatusBadgeContent("attention")).toEqual({
      kind: "pulse",
      bucket: "attention",
    });
  });

  it("shows nothing when the project is done", () => {
    expect(getProjectStatusBadgeContent("done")).toBeNull();
  });

  it("shows nothing when there is no aggregate bucket to surface", () => {
    expect(getProjectStatusBadgeContent(null)).toBeNull();
  });
});
