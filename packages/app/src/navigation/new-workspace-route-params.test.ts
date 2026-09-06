import { describe, expect, it } from "vitest";
import { resolveNewWorkspaceRouteParams } from "./new-workspace-route-params";

describe("resolveNewWorkspaceRouteParams", () => {
  it("reads a prompt from the query parameters", () => {
    expect(
      resolveNewWorkspaceRouteParams({
        q: "Fix the bug & add tests",
      }).initialPrompt,
    ).toBe("Fix the bug & add tests");
  });

  it("preserves the supported query-string route context", () => {
    expect(
      resolveNewWorkspaceRouteParams({
        serverId: "server-1",
        dir: "/repo/project",
        name: "Project",
        projectId: "project-1",
        draftId: "draft-1",
        q: "Start here",
      }),
    ).toEqual({
      serverId: "server-1",
      sourceDirectory: "/repo/project",
      displayName: "Project",
      projectId: "project-1",
      draftId: "draft-1",
      initialPrompt: "Start here",
    });
  });

  it("ignores repeated prompt parameters", () => {
    expect(
      resolveNewWorkspaceRouteParams({
        q: ["first", "second"],
      }).initialPrompt,
    ).toBeUndefined();
  });
});
