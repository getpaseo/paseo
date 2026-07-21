import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import {
  assertAgentCwdExists,
  assertAgentCwdExistsSync,
  isMissingAgentCwdError,
  MISSING_AGENT_CWD_ERROR_CODE,
  MissingAgentCwdError,
  pathIsExistingDirectory,
  pathIsExistingDirectorySync,
  resolveSafeReadRecoveryCwd,
} from "./agent-cwd.js";

const tempDirs: string[] = [];

/** Build a cwd path whose ancestor is a file so stat() raises ENOTDIR. */
function enotdirCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "paseo-agent-cwd-enotdir-"));
  tempDirs.push(dir);
  const fileAncestor = join(dir, "not-a-dir");
  writeFileSync(fileAncestor, "x");
  return join(fileAncestor, "worktree", "agent-cwd");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("agent-cwd", () => {
  test("pathIsExistingDirectory is true for real directories and false for missing paths", async () => {
    const dir = mkdtempSync(join(tmpdir(), "paseo-agent-cwd-"));
    tempDirs.push(dir);
    expect(await pathIsExistingDirectory(dir)).toBe(true);
    expect(await pathIsExistingDirectory(join(dir, "does-not-exist"))).toBe(false);
  });

  test("assertAgentCwdExists throws a structured MissingAgentCwdError", async () => {
    const missing = join(tmpdir(), `paseo-missing-cwd-${Date.now()}`);
    await expect(assertAgentCwdExists("agent-123", missing)).rejects.toSatisfy((error: unknown) => {
      expect(isMissingAgentCwdError(error)).toBe(true);
      expect(error).toBeInstanceOf(MissingAgentCwdError);
      const missingError = error as MissingAgentCwdError;
      expect(missingError.code).toBe(MISSING_AGENT_CWD_ERROR_CODE);
      expect(missingError.agentId).toBe("agent-123");
      expect(missingError.message).toContain("agent-123");
      expect(missingError.message).toContain("working directory is missing");
      expect(missingError.message).toContain("Recreate the worktree");
      expect(missingError.message).not.toMatch(/Agent not found/i);
      return true;
    });
  });

  test("assertAgentCwdExists accepts an existing directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "paseo-agent-cwd-ok-"));
    tempDirs.push(dir);
    await expect(assertAgentCwdExists("agent-ok", dir)).resolves.toBeUndefined();
  });

  test("ENOENT and ENOTDIR are both treated as missing cwd", async () => {
    const enotdirPath = enotdirCwd();
    const enoentPath = join(tmpdir(), `paseo-enoent-cwd-${Date.now()}`);

    // pathIsExistingDirectory: both shapes are false (not raw FS throws).
    expect(await pathIsExistingDirectory(enoentPath)).toBe(false);
    expect(await pathIsExistingDirectory(enotdirPath)).toBe(false);

    // assertAgentCwdExists: both become structured MissingAgentCwdError.
    for (const [label, agentId, path] of [
      ["ENOENT", "agent-missing-path", enoentPath],
      ["ENOTDIR", "agent-file-ancestor", enotdirPath],
    ] as const) {
      await expect(assertAgentCwdExists(agentId, path)).rejects.toSatisfy((error: unknown) => {
        expect(isMissingAgentCwdError(error), `${label} must be MissingAgentCwdError`).toBe(true);
        const missingError = error as MissingAgentCwdError;
        expect(missingError.message).toContain("working directory is missing");
        expect(missingError.message).toMatch(/Recreate the worktree|rebind the agent cwd/i);
        expect(missingError.message).not.toMatch(/\bAgent not found\b/i);
        // Must not leak raw filesystem errno strings into operator-facing text.
        expect(missingError.message).not.toMatch(/\bENOTDIR\b|\bENOENT\b/);
        return true;
      });
      expect(() => assertAgentCwdExistsSync(agentId, path)).toThrow(MissingAgentCwdError);
      expect(pathIsExistingDirectorySync(path)).toBe(false);
    }
  });

  test("resolveSafeReadRecoveryCwd returns an existing directory", () => {
    const safe = resolveSafeReadRecoveryCwd();
    expect(pathIsExistingDirectorySync(safe)).toBe(true);
  });
});
