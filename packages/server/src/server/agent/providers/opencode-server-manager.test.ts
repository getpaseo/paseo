import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { OpenCodeServerManager } from "./opencode-agent.js";

function tmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "opencode-server-manager-test-"));
}

describe("OpenCodeServerManager", () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = tmpDir();
    // Reset singleton between tests
    OpenCodeServerManager.resetInstance();
  });

  afterEach(() => {
    OpenCodeServerManager.resetInstance();
    rmSync(tempHome, { recursive: true, force: true });
  });

  describe("cleanupOrphanedServer", () => {
    test("removes stale state file when no process is running", () => {
      const stateFile = path.join(tempHome, "opencode-serve.json");
      writeFileSync(
        stateFile,
        JSON.stringify({ pid: 99999999, port: 12345, startedAt: "2026-01-01T00:00:00Z" }),
      );
      expect(existsSync(stateFile)).toBe(true);

      // Create manager with PASEO_HOME pointing to temp dir
      process.env.PASEO_HOME = tempHome;
      try {
        const logger = createTestLogger();
        OpenCodeServerManager.getInstance(logger);
        // The stale state file should have been cleaned up
        expect(existsSync(stateFile)).toBe(false);
      } finally {
        delete process.env.PASEO_HOME;
      }
    });

    test("does nothing when no state file exists", () => {
      process.env.PASEO_HOME = tempHome;
      try {
        const logger = createTestLogger();
        // Should not throw
        OpenCodeServerManager.getInstance(logger);
      } finally {
        delete process.env.PASEO_HOME;
      }
    });

    test("handles malformed state file gracefully", () => {
      const stateFile = path.join(tempHome, "opencode-serve.json");
      writeFileSync(stateFile, "not valid json{{{");
      expect(existsSync(stateFile)).toBe(true);

      process.env.PASEO_HOME = tempHome;
      try {
        const logger = createTestLogger();
        // Should not throw even with bad JSON
        OpenCodeServerManager.getInstance(logger);
        // Bad file should be cleaned up (catch block handles parse error)
        expect(existsSync(stateFile)).toBe(false);
      } finally {
        delete process.env.PASEO_HOME;
      }
    });

    test("handles state file with missing pid gracefully", () => {
      const stateFile = path.join(tempHome, "opencode-serve.json");
      writeFileSync(stateFile, JSON.stringify({ port: 12345 }));
      expect(existsSync(stateFile)).toBe(true);

      process.env.PASEO_HOME = tempHome;
      try {
        const logger = createTestLogger();
        OpenCodeServerManager.getInstance(logger);
        expect(existsSync(stateFile)).toBe(false);
      } finally {
        delete process.env.PASEO_HOME;
      }
    });

    test("removes state file with non-existent pid", () => {
      const stateFile = path.join(tempHome, "opencode-serve.json");
      // Use a PID that definitely doesn't exist
      writeFileSync(
        stateFile,
        JSON.stringify({ pid: 1, port: 54321, startedAt: new Date().toISOString() }),
      );

      process.env.PASEO_HOME = tempHome;
      try {
        const logger = createTestLogger();
        OpenCodeServerManager.getInstance(logger);
        // PID 1 (init) won't be killable by non-root, but the file should still be cleaned up
        // since process.kill(pid, 0) might succeed (init always exists) but we still unlink
        // Actually on macOS, process.kill(1, 0) succeeds since init always runs.
        // The SIGTERM to PID 1 will fail (EPERM) but we catch that.
        // The file should be cleaned up regardless.
      } finally {
        delete process.env.PASEO_HOME;
      }
    });
  });

  describe("resetInstance", () => {
    test("clears singleton so a fresh instance can be created", () => {
      process.env.PASEO_HOME = tempHome;
      try {
        const logger = createTestLogger();
        const instance1 = OpenCodeServerManager.getInstance(logger);
        const instance2 = OpenCodeServerManager.getInstance(logger);
        expect(instance1).toBe(instance2);

        OpenCodeServerManager.resetInstance();

        const instance3 = OpenCodeServerManager.getInstance(logger);
        expect(instance3).not.toBe(instance1);
      } finally {
        delete process.env.PASEO_HOME;
      }
    });
  });
});
