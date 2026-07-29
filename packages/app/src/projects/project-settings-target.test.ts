import { describe, expect, it } from "vitest";
import { findProjectSettingsTarget } from "./project-settings-target";

describe("project settings target", () => {
  it("finds a project by its cross-host project key", () => {
    const project = {
      projectKey: "remote:github.com/acme/app",
      hosts: [
        { serverId: "host-a", projectId: "prj_a" },
        { serverId: "host-b", projectId: "prj_b" },
      ],
    };

    expect(findProjectSettingsTarget([project], project.projectKey)).toBe(project);
  });

  it("does not treat a host-local project id as a settings identity", () => {
    const project = {
      projectKey: "remote:github.com/acme/app",
      hosts: [{ serverId: "host-a", projectId: "prj_a" }],
    };

    expect(findProjectSettingsTarget([project], "prj_a")).toBeUndefined();
  });
});
