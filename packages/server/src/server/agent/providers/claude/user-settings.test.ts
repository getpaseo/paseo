import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadClaudeUserSettingsEnv, resetClaudeUserSettingsEnvCache } from "./user-settings.js";

describe("loadClaudeUserSettingsEnv", () => {
  let tmpDir: string;
  let prevConfigDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-claude-settings-"));
    prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = tmpDir;
    resetClaudeUserSettingsEnvCache();
  });

  afterEach(() => {
    if (prevConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    resetClaudeUserSettingsEnvCache();
  });

  function writeSettings(contents: string): void {
    fs.writeFileSync(path.join(tmpDir, "settings.json"), contents, "utf-8");
  }

  it("returns empty object when settings.json does not exist", () => {
    expect(loadClaudeUserSettingsEnv()).toEqual({});
  });

  it("returns empty object when settings.json is malformed JSON", () => {
    writeSettings("{ not valid json");
    expect(loadClaudeUserSettingsEnv()).toEqual({});
  });

  it("returns empty object when env field is missing", () => {
    writeSettings(JSON.stringify({ theme: "dark" }));
    expect(loadClaudeUserSettingsEnv()).toEqual({});
  });

  it("returns empty object when env field is not an object", () => {
    writeSettings(JSON.stringify({ env: "not-an-object" }));
    expect(loadClaudeUserSettingsEnv()).toEqual({});
  });

  it("returns empty object when env field is an array", () => {
    writeSettings(JSON.stringify({ env: ["x", "y"] }));
    expect(loadClaudeUserSettingsEnv()).toEqual({});
  });

  it("returns string env values as-is", () => {
    writeSettings(
      JSON.stringify({
        env: {
          ANTHROPIC_DEFAULT_SONNET_MODEL: "deepseek/deepseek-v4-pro",
          ANTHROPIC_BASE_URL: "https://example.com",
        },
      }),
    );
    expect(loadClaudeUserSettingsEnv()).toEqual({
      ANTHROPIC_DEFAULT_SONNET_MODEL: "deepseek/deepseek-v4-pro",
      ANTHROPIC_BASE_URL: "https://example.com",
    });
  });

  it("filters out non-string env values", () => {
    writeSettings(
      JSON.stringify({
        env: {
          KEEP: "ok",
          DROP_NUMBER: 123,
          DROP_BOOL: true,
          DROP_NULL: null,
          DROP_OBJECT: { nested: "x" },
          DROP_ARRAY: ["a"],
        },
      }),
    );
    expect(loadClaudeUserSettingsEnv()).toEqual({ KEEP: "ok" });
  });

  it("invalidates cache when settings.json mtime changes", () => {
    writeSettings(JSON.stringify({ env: { FOO: "first" } }));
    expect(loadClaudeUserSettingsEnv()).toEqual({ FOO: "first" });

    // Bump mtime forward to guarantee a different value even on coarse FS clocks.
    const filePath = path.join(tmpDir, "settings.json");
    fs.writeFileSync(filePath, JSON.stringify({ env: { FOO: "second" } }), "utf-8");
    const future = new Date(Date.now() + 5_000);
    fs.utimesSync(filePath, future, future);

    expect(loadClaudeUserSettingsEnv()).toEqual({ FOO: "second" });
  });

  it("returns cached result when mtime is unchanged (no re-read on every call)", () => {
    writeSettings(JSON.stringify({ env: { FOO: "first" } }));
    const a = loadClaudeUserSettingsEnv();
    const b = loadClaudeUserSettingsEnv();
    // Same reference -> cache hit.
    expect(a).toBe(b);
  });

  it("recovers when settings.json reappears after being missing", () => {
    expect(loadClaudeUserSettingsEnv()).toEqual({});
    writeSettings(JSON.stringify({ env: { LATER: "ok" } }));
    expect(loadClaudeUserSettingsEnv()).toEqual({ LATER: "ok" });
  });

  it("logs a warning via the provided logger when settings.json fails to parse", () => {
    writeSettings("{ not valid json");
    const calls: { obj: Record<string, unknown>; msg: string }[] = [];
    const logger = {
      warn: (obj: Record<string, unknown>, msg: string) => {
        calls.push({ obj, msg });
      },
    };

    expect(loadClaudeUserSettingsEnv(logger)).toEqual({});
    expect(calls).toHaveLength(1);
    expect(calls[0]?.msg).toContain("Failed to parse Claude user settings.json");
    expect(calls[0]?.obj.filePath).toBe(path.join(tmpDir, "settings.json"));
    expect(typeof calls[0]?.obj.err).toBe("string");
  });

  it("does not log when parsing succeeds", () => {
    writeSettings(JSON.stringify({ env: { OK: "yes" } }));
    const calls: unknown[] = [];
    const logger = {
      warn: (obj: Record<string, unknown>, msg: string) => {
        calls.push({ obj, msg });
      },
    };

    expect(loadClaudeUserSettingsEnv(logger)).toEqual({ OK: "yes" });
    expect(calls).toHaveLength(0);
  });
});
