import { describe, expect, it } from "vitest";
import { canManageWorkspaceLaunches } from "./workspace-launches-capability";

describe("canManageWorkspaceLaunches", () => {
  it("requires the active daemon to explicitly advertise launch support", () => {
    expect(canManageWorkspaceLaunches(undefined)).toBe(false);
    expect(canManageWorkspaceLaunches(null)).toBe(false);
    expect(canManageWorkspaceLaunches({})).toBe(false);
    expect(canManageWorkspaceLaunches({ features: {} })).toBe(false);
    expect(canManageWorkspaceLaunches({ features: { workspaceLaunchManagement: false } })).toBe(
      false,
    );
    expect(canManageWorkspaceLaunches({ features: { workspaceLaunchManagement: true } })).toBe(
      true,
    );
  });

  it("revokes launch access on downgrade even while workspace descriptors remain cached", () => {
    const cachedWorkspace = { launches: [{ launchName: "dev" }] };
    let serverInfo = { features: { workspaceLaunchManagement: true } };
    expect(canManageWorkspaceLaunches(serverInfo)).toBe(true);
    serverInfo = { features: { workspaceLaunchManagement: false } };
    expect(cachedWorkspace.launches).toEqual([{ launchName: "dev" }]);
    expect(canManageWorkspaceLaunches(serverInfo)).toBe(false);
  });
});
