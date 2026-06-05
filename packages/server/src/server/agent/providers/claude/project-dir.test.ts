import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { getSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { claudeProjectDir, claudeProjectDirSync } from "./project-dir.js";

// Parity oracle: the Claude SDK's getSessionInfo({ dir }) canonicalizes the
// given dir with the SDK's own encoder and looks for `<sessionId>.jsonl` under
// that path. If we write a session file at the path our function computes and
// the SDK finds it, our encoding matches theirs for that input.

const workspaceRoot = join(homedir(), ".paseo-claude-parity-tests");
const tmpWorkspaceRoot = join(tmpdir(), "paseo-claude-parity");
const createdSessionFiles: string[] = [];

interface ParityCase {
  label: string;
  build(): Promise<string>;
}

const cases: ParityCase[] = [
  {
    label: "plain path under home",
    build: () => ensureDir(join(workspaceRoot, "plain")),
  },
  {
    label: "path with spaces",
    build: () => ensureDir(join(workspaceRoot, "with spaces and stuff")),
  },
  {
    label: "path with parens and other shell-meta",
    build: () => ensureDir(join(workspaceRoot, "proj (work) [v2]")),
  },
  {
    label: "path with combining-mark unicode (NFD input)",
    build: () => ensureDir(join(workspaceRoot, "cafe\u0301-nfd")),
  },
  {
    label: "path under macOS tmpdir (realpath delta)",
    build: () => ensureDir(join(tmpWorkspaceRoot, "var-folders-case")),
  },
  {
    label: "user-defined symlink",
    build: async () => {
      const real = await ensureDir(join(workspaceRoot, "real-target"));
      const link = join(workspaceRoot, "via-symlink");
      if (!existsSync(link)) {
        await symlink(real, link);
      }
      return link;
    },
  },
  {
    label: "deep path that triggers truncation + hash",
    build: async () => {
      // ~60 segments × 6 chars = 360+ char path, well past the 200-char cap.
      let p = workspaceRoot;
      for (let i = 0; i < 60; i++) p = join(p, `seg${i.toString().padStart(3, "0")}`);
      return ensureDir(p);
    },
  },
  {
    label: "non-existent path (canonicalize fallback)",
    // realpath will throw; canonicalize falls back to NFC of input. SDK does
    // the same, so paths should still match.
    build: async () => join(workspaceRoot, "this-path-was-never-created-" + randomUUID()),
  },
];

describe("claudeProjectDir parity with Claude Agent SDK", () => {
  beforeAll(async () => {
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(tmpWorkspaceRoot, { recursive: true });
  });

  afterAll(async () => {
    for (const file of createdSessionFiles) {
      await rm(file, { force: true });
    }
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(tmpWorkspaceRoot, { recursive: true, force: true });
  });

  for (const c of cases) {
    test(c.label, async () => {
      const cwd = await c.build();
      const sessionId = randomUUID();

      const ourDir = await claudeProjectDir(cwd);
      await mkdir(ourDir, { recursive: true });
      const sessionFile = join(ourDir, `${sessionId}.jsonl`);
      await writeFile(sessionFile, '{"type":"summary","summary":"parity"}\n');
      createdSessionFiles.push(sessionFile);

      const info = await getSessionInfo(sessionId, { dir: cwd });
      expect(info?.sessionId).toBe(sessionId);
    });
  }

  test("sync helper uses the same directory as the SDK-parity helper", async () => {
    const cwd = await ensureDir(join(workspaceRoot, "sync path with spaces"));

    await expect(claudeProjectDir(cwd)).resolves.toBe(claudeProjectDirSync(cwd));
  });
});

async function ensureDir(path: string): Promise<string> {
  await mkdir(path, { recursive: true });
  return path;
}
