import { describe, expect, it } from "vitest";
import { executeDaemonManagementToggle } from "./daemon-management-toggle";

function makeDeps() {
  const persisted: { manageBuiltInDaemon: boolean }[] = [];
  return {
    deps: {
      persistSettings: async (next: { manageBuiltInDaemon: boolean }) => {
        persisted.push(next);
      },
    },
    persisted,
  };
}

describe("executeDaemonManagementToggle", () => {
  it("persists manageBuiltInDaemon: true when enabling the launch preference", async () => {
    const { deps, persisted } = makeDeps();

    const result = await executeDaemonManagementToggle(false, deps);

    expect(persisted).toEqual([{ manageBuiltInDaemon: true }]);
    expect(result).toBe("enabled");
  });

  it("persists manageBuiltInDaemon: false when disabling the launch preference", async () => {
    const { deps, persisted } = makeDeps();

    const result = await executeDaemonManagementToggle(true, deps);

    expect(persisted).toEqual([{ manageBuiltInDaemon: false }]);
    expect(result).toBe("disabled");
  });
});
