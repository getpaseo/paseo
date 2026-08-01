import { describe, expect, it } from "vitest";
import { getProjectStatusBadgeContent } from "./project-status-badge-content";

describe("getProjectStatusBadgeContent", () => {
  it("shows the loader while running", () => {
    expect(getProjectStatusBadgeContent("running")).toEqual({ kind: "loader" });
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

  it("shows nothing when there is no aggregate bucket to surface", () => {
    expect(getProjectStatusBadgeContent(null)).toBeNull();
  });
});
