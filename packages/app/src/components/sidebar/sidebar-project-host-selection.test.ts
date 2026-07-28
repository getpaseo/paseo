import { describe, expect, it } from "vitest";
import { resolveProjectFileManagerPlacement } from "./sidebar-project-host-selection";

describe("resolveProjectFileManagerPlacement", () => {
  it("selects local placement when remote host is first and local host is second with identical path", () => {
    const project = {
      iconWorkingDir: "/home/user/app",
      hosts: [
        { serverId: "remote-daemon-1", iconWorkingDir: "/home/user/app" },
        { serverId: "local-daemon-1", iconWorkingDir: "/home/user/app" },
      ],
    };

    const placement = resolveProjectFileManagerPlacement(project, "local-daemon-1");

    expect(placement).toEqual({
      projectPath: "/home/user/app",
      projectServerId: "local-daemon-1",
    });
  });

  it("selects local placement when local host is first and remote host is second", () => {
    const project = {
      iconWorkingDir: "/Users/local/app",
      hosts: [
        { serverId: "local-daemon-1", iconWorkingDir: "/Users/local/app" },
        { serverId: "remote-daemon-1", iconWorkingDir: "/home/user/app" },
      ],
    };

    const placement = resolveProjectFileManagerPlacement(project, "local-daemon-1");

    expect(placement).toEqual({
      projectPath: "/Users/local/app",
      projectServerId: "local-daemon-1",
    });
  });

  it("uses local placement path when local and remote hosts have different paths", () => {
    const project = {
      iconWorkingDir: "/home/user/remote-app",
      hosts: [
        { serverId: "remote-daemon-1", iconWorkingDir: "/home/user/remote-app" },
        { serverId: "local-daemon-1", iconWorkingDir: "C:\\Users\\local\\app" },
      ],
    };

    const placement = resolveProjectFileManagerPlacement(project, "local-daemon-1");

    expect(placement).toEqual({
      projectPath: "C:\\Users\\local\\app",
      projectServerId: "local-daemon-1",
    });
  });

  it("falls back to project.iconWorkingDir and remote serverId when project is only on remote host", () => {
    const project = {
      iconWorkingDir: "/home/user/remote-only",
      hosts: [{ serverId: "remote-daemon-1", iconWorkingDir: "/home/user/remote-only" }],
    };

    const placement = resolveProjectFileManagerPlacement(project, "local-daemon-1");

    expect(placement).toEqual({
      projectPath: "/home/user/remote-only",
      projectServerId: "remote-daemon-1",
    });
  });

  it("falls back to project.iconWorkingDir when local daemon serverId is null", () => {
    const project = {
      iconWorkingDir: "/some/path",
      hosts: [{ serverId: "some-daemon", iconWorkingDir: "/some/path" }],
    };

    const placement = resolveProjectFileManagerPlacement(project, null);

    expect(placement).toEqual({
      projectPath: "/some/path",
      projectServerId: "some-daemon",
    });
  });
});
