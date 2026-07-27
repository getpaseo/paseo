import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteClaudeNativeSession } from "./delete-native-session.js";

describe("deleteClaudeNativeSession", () => {
  let tmpDir: string;
  let configDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "delete-claude-native-session-test-"));
    configDir = tmpDir;
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("deletes the session JSONL file", async () => {
    const cwd = "/some/project/dir";
    const sessionId = "test-session-abc123";

    // Compute the project dir path as claudeProjectDir would
    const encoded = cwd.replace(/[^a-zA-Z0-9]/g, "-");
    const projectDir = join(configDir, "projects", encoded);
    await mkdir(projectDir, { recursive: true });

    const jsonlPath = join(projectDir, `${sessionId}.jsonl`);
    await writeFile(jsonlPath, '{"type":"message"}\n');

    await deleteClaudeNativeSession(cwd, sessionId, configDir);

    const files = await readdir(projectDir);
    expect(files).not.toContain(`${sessionId}.jsonl`);
  });

  it("deletes the session sidecar directory if present", async () => {
    const cwd = "/some/project/dir";
    const sessionId = "test-session-abc123";

    const encoded = cwd.replace(/[^a-zA-Z0-9]/g, "-");
    const projectDir = join(configDir, "projects", encoded);
    await mkdir(projectDir, { recursive: true });

    const sidecarDir = join(projectDir, sessionId);
    await mkdir(sidecarDir, { recursive: true });
    await writeFile(join(sidecarDir, "artifact.txt"), "data");

    const jsonlPath = join(projectDir, `${sessionId}.jsonl`);
    await writeFile(jsonlPath, '{"type":"message"}\n');

    await deleteClaudeNativeSession(cwd, sessionId, configDir);

    const files = await readdir(projectDir);
    expect(files).not.toContain(sessionId);
    expect(files).not.toContain(`${sessionId}.jsonl`);
  });

  it("is a no-op when the session file does not exist", async () => {
    await expect(
      deleteClaudeNativeSession("/some/cwd", "nonexistent-session", configDir),
    ).resolves.toBeUndefined();
  });

  it("is a no-op when cwd is undefined", async () => {
    await expect(
      deleteClaudeNativeSession(undefined, "some-session", configDir),
    ).resolves.toBeUndefined();
  });

  it("is a no-op when sessionId is undefined", async () => {
    await expect(
      deleteClaudeNativeSession("/some/cwd", undefined, configDir),
    ).resolves.toBeUndefined();
  });
});
