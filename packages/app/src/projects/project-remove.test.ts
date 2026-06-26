import { describe, expect, it } from "vitest";
import {
  getProjectRemoveReadiness,
  removeProjectFromHosts,
  type ProjectRemoveProject,
} from "./project-remove";

const project: ProjectRemoveProject = {
  projectKey: "remote:github.com/acme/app",
  hosts: [{ serverId: "host-a" }, { serverId: "host-b" }],
};

function createProjectRemoveClient() {
  const removedProjectKeys: string[] = [];
  return {
    removedProjectKeys,
    client: {
      async removeProject(projectKey: string): Promise<{ removedWorkspaceIds: string[] }> {
        removedProjectKeys.push(projectKey);
        return { removedWorkspaceIds: [] };
      },
    },
  };
}

describe("project remove policy", () => {
  it("requires every host to support project removal", () => {
    const readiness = getProjectRemoveReadiness({
      project,
      supportsProjectRemove: (serverId) => serverId === "host-a",
    });

    expect(readiness).toEqual({
      kind: "needs_host_update",
      serverIds: ["host-b"],
    });
  });

  it("removes the project from every participating host", async () => {
    const hostA = createProjectRemoveClient();
    const hostB = createProjectRemoveClient();
    const readiness = getProjectRemoveReadiness({
      project,
      supportsProjectRemove: () => true,
    });

    expect(readiness).toEqual({
      kind: "ready",
      targets: [{ serverId: "host-a" }, { serverId: "host-b" }],
    });

    const outcome = await removeProjectFromHosts({
      projectKey: project.projectKey,
      targets: [{ serverId: "host-a" }, { serverId: "host-b" }],
      getClient: (serverId) => {
        if (serverId === "host-a") return hostA.client;
        if (serverId === "host-b") return hostB.client;
        return null;
      },
    });

    expect(outcome).toEqual({ kind: "removed", serverIds: ["host-a", "host-b"] });
    expect(hostA.removedProjectKeys).toEqual([project.projectKey]);
    expect(hostB.removedProjectKeys).toEqual([project.projectKey]);
  });

  it("reports disconnected hosts before sending any remove request", async () => {
    const hostA = createProjectRemoveClient();

    const outcome = await removeProjectFromHosts({
      projectKey: project.projectKey,
      targets: [{ serverId: "host-a" }, { serverId: "host-b" }],
      getClient: (serverId) => (serverId === "host-a" ? hostA.client : null),
    });

    expect(outcome).toEqual({ kind: "host_disconnected", serverIds: ["host-b"] });
    expect(hostA.removedProjectKeys).toEqual([]);
  });
});
