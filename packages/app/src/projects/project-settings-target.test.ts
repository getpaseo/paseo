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
});
