import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import {
  assertAgentCwdExists,
  isMissingAgentCwdError,
  MISSING_AGENT_CWD_ERROR_CODE,
  MissingAgentCwdError,
  pathIsExistingDirectory,
} from "./agent-cwd.js";

const tempDirs: string[] = [];

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
});
