import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";

import { createInitialMutableDaemonConfig, fanOutReconciledWorkspaceUpdates } from "./bootstrap.js";
import { loadConfig } from "./config.js";

const temporaryHomes: string[] = [];

afterEach(() => {
  while (temporaryHomes.length > 0) {
    const home = temporaryHomes.pop();
    if (home) rmSync(home, { recursive: true, force: true });
  }
});

function seedPaseoHome(daemon: Record<string, unknown>): string {
  const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-shell-migration-"));
  temporaryHomes.push(paseoHome);
  writeFileSync(path.join(paseoHome, "config.json"), JSON.stringify({ version: 1, daemon }));
  return paseoHome;
}

test("reconciliation emits workspace updates when observer sync fails", async () => {
  const emittedWorkspaceIds: string[][] = [];
  const syncFailure = new Error("workspace observer unavailable");

  await fanOutReconciledWorkspaceUpdates({
    sessions: [
      {
        syncWorkspaceGitObserversForExternalWorkspaceIds: async () => {
          throw syncFailure;
        },
        emitWorkspaceUpdatesForExternalWorkspaceIds: async (workspaceIds) => {
          emittedWorkspaceIds.push(Array.from(workspaceIds));
        },
      },
    ],
    workspaceIds: ["ws-reclassified"],
    logger: { warn: () => {} },
  });

  expect(emittedWorkspaceIds).toEqual([["ws-reclassified"]]);
});

test("reconciliation isolates workspace update failures between sessions", async () => {
  const emittedWorkspaceIds: string[][] = [];
  const warnings: unknown[] = [];

  await fanOutReconciledWorkspaceUpdates({
    sessions: [
      {
        syncWorkspaceGitObserversForExternalWorkspaceIds: async () => {},
        emitWorkspaceUpdatesForExternalWorkspaceIds: async () => {
          throw new Error("session closed");
        },
      },
      {
        syncWorkspaceGitObserversForExternalWorkspaceIds: async () => {},
        emitWorkspaceUpdatesForExternalWorkspaceIds: async (workspaceIds) => {
          emittedWorkspaceIds.push(Array.from(workspaceIds));
        },
      },
    ],
    workspaceIds: ["ws-reclassified"],
    logger: {
      warn: (context) => {
        warnings.push(context);
      },
    },
  });

  expect(emittedWorkspaceIds).toEqual([["ws-reclassified"]]);
  expect(warnings).toHaveLength(1);
});

// The per-host terminal shell setting never shipped, but a developer running
// this branch has one on disk. It has to become a default terminal profile
// pointing at a real binary, without discarding the shipped profiles the user
// never edited.
test("migrates a persisted terminal shell into a default terminal profile", async () => {
  const shellPath = path.join(tmpdir(), "pwsh.exe");
  const paseoHome = seedPaseoHome({
    terminalShell: "custom",
    customTerminalShellPath: shellPath,
  });

  const mutable = await createInitialMutableDaemonConfig(loadConfig(paseoHome, { env: {} }));

  expect(mutable.defaultTerminalProfileId).toBe("shell-custom");
  expect(mutable.terminalProfiles).toContainEqual({
    id: "shell-custom",
    name: "pwsh.exe",
    command: shellPath,
  });
  expect(mutable.terminalProfiles?.some((profile) => profile.id === "codex")).toBe(true);
});

// The migration runs at every start until a patch writes the result back, so a
// recorded default has to stop it rather than appending a second copy.
test("does not migrate again once a default terminal profile is recorded", async () => {
  const paseoHome = seedPaseoHome({
    terminalShell: "custom",
    customTerminalShellPath: path.join(tmpdir(), "pwsh.exe"),
    defaultTerminalProfileId: "shell-custom",
    terminalProfiles: [{ id: "shell-custom", name: "pwsh.exe", command: "pwsh.exe" }],
  });

  const mutable = await createInitialMutableDaemonConfig(loadConfig(paseoHome, { env: {} }));

  expect(mutable.defaultTerminalProfileId).toBe("shell-custom");
  expect(mutable.terminalProfiles).toEqual([
    { id: "shell-custom", name: "pwsh.exe", command: "pwsh.exe" },
  ]);
});

// A default profile that cannot spawn is worse than no default, so an
// uninstalled shell migrates to nothing and the system shell stays in charge.
test("leaves no default when the persisted shell is not installed", async () => {
  const paseoHome = seedPaseoHome({ terminalShell: "paseo-nonexistent-shell" });

  const mutable = await createInitialMutableDaemonConfig(loadConfig(paseoHome, { env: {} }));

  expect(mutable.defaultTerminalProfileId).toBe("");
  expect(mutable.terminalProfiles).toBeUndefined();
});
