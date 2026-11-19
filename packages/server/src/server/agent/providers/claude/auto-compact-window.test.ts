import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import {
  readClaudeAutoCompactWindows,
  resolveClaudeAutoCompactWindow,
} from "./auto-compact-window.js";

let root: string;
let configDir: string;
let cwd: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "claude-auto-compact-"));
  configDir = join(root, "config");
  cwd = join(root, "project");
  await mkdir(configDir, { recursive: true });
  await mkdir(join(cwd, ".claude"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeSettings(
  file: "user" | "project" | "local",
  settings: Record<string, unknown>,
): Promise<void> {
  const paths = {
    user: join(configDir, "settings.json"),
    project: join(cwd, ".claude", "settings.json"),
    local: join(cwd, ".claude", "settings.local.json"),
  };
  await writeFile(paths[file], JSON.stringify(settings), "utf8");
}

async function resolveFor(
  modelId: string | undefined,
  env: Record<string, string> = {},
): Promise<number | undefined> {
  const windows = await readClaudeAutoCompactWindows({
    configDir,
    cwd,
    env,
    logger: createTestLogger(),
  });
  return resolveClaudeAutoCompactWindow(windows, modelId);
}

describe("readClaudeAutoCompactWindows", () => {
  test("applies a model's window to every spelling of that model", async () => {
    await writeSettings("user", {
      modelSettings: { "claude-opus-5-5": { autoCompactWindow: 300_000 } },
    });

    expect(await resolveFor("claude-opus-5-5")).toBe(300_000);
    expect(await resolveFor("claude-opus-5-5[1m]")).toBe(300_000);
    expect(await resolveFor("claude-opus-5-5-20261001")).toBe(300_000);
    expect(await resolveFor("us.anthropic.claude-opus-5-5-v1:0")).toBe(300_000);
    expect(await resolveFor("claude-sonnet-5-5")).toBeUndefined();
  });

  test("falls back to the top-level window and lets a model opt out with auto", async () => {
    await writeSettings("user", {
      autoCompactWindow: 400_000,
      modelSettings: {
        "claude-opus-5-5": { autoCompactWindow: 300_000 },
        "claude-sonnet-5-5": { autoCompactWindow: "auto" },
      },
    });

    expect(await resolveFor("claude-opus-5-5")).toBe(300_000);
    expect(await resolveFor("claude-haiku-4-5")).toBe(400_000);
    expect(await resolveFor("claude-sonnet-5-5")).toBeUndefined();
    expect(await resolveFor(undefined)).toBe(400_000);
  });

  test("lets project and local settings override user settings", async () => {
    await writeSettings("user", {
      modelSettings: {
        "claude-opus-5-5": { autoCompactWindow: 300_000 },
        "claude-sonnet-5-5": { autoCompactWindow: 500_000 },
      },
    });
    await writeSettings("local", {
      modelSettings: { "claude-opus-5-5": { autoCompactWindow: 250_000 } },
    });

    expect(await resolveFor("claude-opus-5-5")).toBe(250_000);
    expect(await resolveFor("claude-sonnet-5-5")).toBe(500_000);

    // A file that sets the top-level window replaces the per-model windows below it.
    await writeSettings("project", { autoCompactWindow: 600_000 });
    expect(await resolveFor("claude-sonnet-5-5")).toBe(600_000);
    expect(await resolveFor("claude-opus-5-5")).toBe(250_000);
  });

  test("prefers the canonical spelling within one file", async () => {
    await writeSettings("user", {
      modelSettings: {
        "claude-opus-5-5[1m]": { autoCompactWindow: 700_000 },
        "claude-opus-5-5": { autoCompactWindow: 300_000 },
      },
    });

    expect(await resolveFor("claude-opus-5-5[1m]")).toBe(300_000);
  });

  test("ignores values Claude Code rejects and unreadable files", async () => {
    await writeSettings("user", {
      autoCompactWindow: 50_000,
      modelSettings: { "claude-opus-5-5": { autoCompactWindow: 2_000_000 } },
    });
    await writeFile(join(cwd, ".claude", "settings.local.json"), "{ not json", "utf8");

    expect(await resolveFor("claude-opus-5-5")).toBeUndefined();
  });

  test("lets CLAUDE_CODE_AUTO_COMPACT_WINDOW override every setting", async () => {
    await writeSettings("user", {
      modelSettings: { "claude-opus-5-5": { autoCompactWindow: 300_000 } },
    });

    const opus = "claude-opus-5-5";
    expect(await resolveFor(opus, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "200k" })).toBe(200_000);
    expect(await resolveFor(opus, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "0.5m" })).toBe(500_000);
    expect(await resolveFor(opus, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "450000" })).toBe(450_000);
    expect(await resolveFor(opus, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "50000" })).toBe(100_000);
    expect(await resolveFor(opus, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "2M" })).toBe(1_000_000);
    expect(await resolveFor(opus, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "lots" })).toBe(300_000);

    await writeSettings("project", { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "350k" } });
    expect(await resolveFor(opus, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "200k" })).toBe(350_000);
  });
});
