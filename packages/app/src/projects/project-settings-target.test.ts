import { describe, expect, it } from "vitest";
import {
  findProjectSettingsRouteTarget,
  findProjectSettingsTarget,
  resolveHostProjectSettingsRouteKey,
  resolveProjectSettingsServerId,
  resolveProjectSettingsRouteKey,
} from "./project-settings-target";

describe("project settings target", () => {
  const project = {
    projectKey: "remote:github.com/acme/app",
    hosts: [{ serverId: "host-a", projectId: "prj_1234" }],
  };

  it("builds settings routes from stable host-local identity", () => {
    expect(resolveProjectSettingsRouteKey(project)).toBe("host:6:host-a:project:8:prj_1234");
  });

  it("keeps a host-local route valid after the structural key changes", () => {
    expect(findProjectSettingsTarget([project], "host:6:host-a:project:8:prj_1234")).toBe(project);
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
    const encodedLegacyKey = encodeURIComponent(legacyKey);
    expect(routeKey).toBe(`host:6:host-b:project:${encodedLegacyKey.length}:${encodedLegacyKey}`);
    expect(findProjectSettingsTarget([unchangedProject, changedProject], routeKey)).toBe(
      changedProject,
    );
  });

  it("frames opaque host and project IDs without collisions", () => {
    const first = resolveHostProjectSettingsRouteKey({
      serverId: "a",
      projectId: "b:project:c",
    });
    const second = resolveHostProjectSettingsRouteKey({
      serverId: "a:project:b",
      projectId: "c",
    });

    expect(first).not.toBe(second);
  });

  it("preserves whitespace in opaque project IDs", () => {
    const withoutTrailingSpace = resolveHostProjectSettingsRouteKey({
      serverId: "host-a",
      projectId: "/repo/foo",
    });
    const withTrailingSpace = resolveHostProjectSettingsRouteKey({
      serverId: "host-a",
      projectId: "/repo/foo ",
    });

    expect(withTrailingSpace).not.toBe(withoutTrailingSpace);
  });

  it("prefers an online host for a generic grouped settings route", () => {
    const groupedProject = {
      projectKey: "remote:github.com/acme/app",
      hosts: [
        { serverId: "host-a", projectId: "project-a", isOnline: false },
        { serverId: "host-b", projectId: "project-b", isOnline: true },
      ],
    };

    expect(resolveProjectSettingsRouteKey(groupedProject)).toBe(
      resolveHostProjectSettingsRouteKey(groupedProject.hosts[1]),
    );
  });

  it("preserves the host identified by a grouped settings route", () => {
    const groupedProject = {
      projectKey: "remote:github.com/acme/app",
      hosts: [
        { serverId: "host-a", projectId: "project-a" },
        { serverId: "host-b", projectId: "project-b" },
      ],
    };
    const routeKey = resolveHostProjectSettingsRouteKey(groupedProject.hosts[1]);

    expect(routeKey).not.toBeNull();
    expect(findProjectSettingsRouteTarget([groupedProject], routeKey ?? "")).toEqual({
      project: groupedProject,
      serverId: "host-b",
    });
  });

  it("does not retarget an unavailable routed host", () => {
    expect(
      resolveProjectSettingsServerId({
        projectKey: "remote:github.com/acme/app",
        editableServerIds: ["host-a"],
        routedServerId: "host-b",
        hostSelection: { routeKey: "", serverId: "" },
      }),
    ).toBe("host-b");
  });
});
