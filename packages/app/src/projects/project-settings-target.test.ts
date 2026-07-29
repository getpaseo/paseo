import { describe, expect, it } from "vitest";
import {
  findProjectSettingsTarget,
  resolveProjectSettingsRouteKey,
} from "./project-settings-target";

describe("project settings target", () => {
  const project = {
    projectKey: "remote:github.com/acme/app",
    hosts: [{ serverId: "host-a", projectId: "prj_1234" }],
  };

  it("builds settings routes from stable host-local identity", () => {
    expect(resolveProjectSettingsRouteKey(project)).toBe("host:host-a:project:prj_1234");
  });

  it("keeps a host-local route valid after the structural key changes", () => {
    expect(findProjectSettingsTarget([project], "host:host-a:project:prj_1234")).toBe(project);
  });

  it("keeps legacy project IDs scoped to their host", () => {
    const legacyKey = "remote:github.com/acme/app";
    const unchangedProject = {
      projectKey: legacyKey,
      hosts: [{ serverId: "host-a", projectId: legacyKey }],
    };
    const changedProject = {
      projectKey: "remote:github.com/acme/app-fork",
      hosts: [{ serverId: "host-b", projectId: legacyKey }],
    };

    const routeKey = resolveProjectSettingsRouteKey(changedProject);
    expect(routeKey).toBe(`host:host-b:project:${legacyKey}`);
    expect(findProjectSettingsTarget([unchangedProject, changedProject], routeKey)).toBe(
      changedProject,
    );
  });
});
