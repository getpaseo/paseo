import { describe, expect, it } from "vitest";
import { buildExistingProjectChoices } from "./options";

const PROJECTS = [
  {
    projectKey: "prj_existing",
    projectName: "Existing App",
    projectKind: "git" as const,
    iconWorkingDir: "/projects/existing-app",
    hosts: [
      {
        serverId: "host-a",
        iconWorkingDir: "/projects/existing-app",
        canCreateWorktree: true,
      },
    ],
    workspaceKeys: ["host-a:ws-existing"],
  },
  {
    projectKey: "prj_other",
    projectName: "Other App",
    projectKind: "directory" as const,
    iconWorkingDir: "/projects/other-app",
    hosts: [
      {
        serverId: "host-a",
        iconWorkingDir: "/projects/other-app",
        canCreateWorktree: false,
      },
    ],
    workspaceKeys: ["host-a:ws-other"],
  },
];

describe("buildExistingProjectChoices", () => {
  it("returns direct-selectable existing projects that match the search", () => {
    expect(
      buildExistingProjectChoices({ projects: PROJECTS, serverId: "host-a", query: "existing" }),
    ).toEqual([
      {
        project: PROJECTS[0],
        sourceDirectory: "/projects/existing-app",
      },
    ]);
  });

  it("does not offer projects from another host", () => {
    expect(
      buildExistingProjectChoices({ projects: PROJECTS, serverId: "host-b", query: "" }),
    ).toEqual([]);
  });
});
