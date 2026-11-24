import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getPaseoWorktreeMetadataPath,
  readPaseoWorktreeMetadata,
  writePaseoWorktreeMetadata,
} from "../utils/worktree-metadata.js";
import {
  WorkspaceAutomationBlockedError,
  assertWorkspaceAutomationAllowed,
  clearWorkspaceAutomationBlock,
  formatWorkspaceAutomationBlockedMessage,
} from "./workspace-automation-gate.js";
import type { PersistedWorkspaceRecord } from "./workspace-registry.js";

const cleanupPaths: string[] = [];

afterEach(() => {
  for (const target of cleanupPaths.splice(0)) {
    rmSync(target, { recursive: true, force: true });
  }
});

describe("workspace automation gate", () => {
  it("refuses executable repository automation for a cross-repository change request", () => {
    expect(() =>
      assertWorkspaceAutomationAllowed({
        kind: "change_request",
        forge: "github",
        number: 42,
        headRepository: "contributor/paseo",
      }),
    ).toThrowError(
      new WorkspaceAutomationBlockedError({
        kind: "change_request",
        forge: "github",
        number: 42,
        headRepository: "contributor/paseo",
      }),
    );
  });

  it("allows executable repository automation for ordinary workspaces", () => {
    expect(() => assertWorkspaceAutomationAllowed(undefined)).not.toThrow();
  });

  it.each([
    ["github", "PR"],
    ["gitea", "PR"],
    ["forgejo", "PR"],
    ["gitlab", "MR"],
  ])("uses the %s change request noun", (forge, noun) => {
    expect(
      formatWorkspaceAutomationBlockedMessage({
        kind: "change_request",
        forge,
        number: 42,
        headRepository: "contributor/paseo",
      }),
    ).toBe(`Scripts are blocked for ${noun} #42 from contributor/paseo. Run setup to allow them.`);
  });

  async function createUntrustedWorktreeFixture(number: number) {
    const tempDir = mkdtempSync(path.join(tmpdir(), `automation-gate-${number}-`));
    cleanupPaths.push(tempDir);
    const repoDir = path.join(tempDir, "repo");
    const worktreeDir = path.join(tempDir, "wt");
    mkdirSync(repoDir, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["config", "user.email", "test@getpaseo.local"], {
      cwd: repoDir,
      stdio: "pipe",
    });
    execFileSync("git", ["config", "user.name", "Paseo Test"], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "init"], {
      cwd: repoDir,
      stdio: "pipe",
    });
    execFileSync("git", ["worktree", "add", "-b", `pr-${number}`, worktreeDir, "main"], {
      cwd: repoDir,
      stdio: "pipe",
    });
    const source = {
      kind: "change_request" as const,
      forge: "github",
      number,
      headRepository: "contributor/paseo",
    };
    await writePaseoWorktreeMetadata(worktreeDir, { baseRefName: "main", untrustedSource: source });
    const records = new Map<string, PersistedWorkspaceRecord>([
      [
        "ws-1",
        {
          workspaceId: "ws-1",
          projectId: "proj-1",
          cwd: worktreeDir,
          kind: "worktree",
          worktreeRoot: worktreeDir,
          isPaseoOwnedWorktree: true,
          mainRepoRoot: repoDir,
          untrustedSource: source,
          createdAt: "2026-11-24T00:00:00.000Z",
          updatedAt: "2026-11-24T00:00:00.000Z",
        },
      ],
    ]);
    const registry = {
      listAll: async () => Array.from(records.values()),
      update: async (
        id: string,
        updater: (record: PersistedWorkspaceRecord) => PersistedWorkspaceRecord,
      ) => {
        const current = records.get(id);
        if (!current) return null;
        const next = updater(current);
        records.set(id, next);
        return next;
      },
    };
    return { worktreeDir, source, records, registry };
  }

  it("clears untrustedSource from both workspace records and worktree metadata", async () => {
    const { worktreeDir, records, registry } = await createUntrustedWorktreeFixture(42);

    const cleared = await clearWorkspaceAutomationBlock(registry, "ws-1");

    expect(cleared).toBe(true);
    expect(records.get("ws-1")?.untrustedSource).toBeUndefined();
    expect((await readPaseoWorktreeMetadata(worktreeDir))?.untrustedSource).toBeUndefined();
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "fails without clearing workspace records when worktree metadata cannot be written",
    async () => {
      const { worktreeDir, source, records, registry } = await createUntrustedWorktreeFixture(43);
      const metadataDir = path.dirname(await getPaseoWorktreeMetadataPath(worktreeDir));

      chmodSync(metadataDir, 0o555);
      try {
        await expect(clearWorkspaceAutomationBlock(registry, "ws-1")).rejects.toThrow();
        expect(records.get("ws-1")?.untrustedSource).toEqual(source);
        expect((await readPaseoWorktreeMetadata(worktreeDir))?.untrustedSource).toEqual(source);
      } finally {
        chmodSync(metadataDir, 0o755);
      }

      const retried = await clearWorkspaceAutomationBlock(registry, "ws-1");
      expect(retried).toBe(true);
      expect(records.get("ws-1")?.untrustedSource).toBeUndefined();
      expect((await readPaseoWorktreeMetadata(worktreeDir))?.untrustedSource).toBeUndefined();
    },
  );
});
