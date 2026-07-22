import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  encodeGrokSessionsCwdDirname,
  readGrokSubagentDiskMeta,
  resolveGrokHome,
} from "./grok-subagent-meta.js";

const CANONICAL = {
  low: "low",
  high: "high",
  max: "xhigh",
};

describe("grok-subagent-meta", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("resolveGrokHome prefers GROK_HOME", () => {
    expect(resolveGrokHome({ GROK_HOME: "/tmp/custom-grok" })).toBe("/tmp/custom-grok");
  });

  test("reads model and reasoning from child summary.json via cwd path", () => {
    const grokHome = mkdtempSync(join(tmpdir(), "paseo-grok-meta-"));
    tempDirs.push(grokHome);
    const cwd = "/workspace/project";
    const childId = "child-session-1";
    const summaryDir = join(grokHome, "sessions", encodeGrokSessionsCwdDirname(cwd), childId);
    mkdirSync(summaryDir, { recursive: true });
    writeFileSync(
      join(summaryDir, "summary.json"),
      JSON.stringify({
        current_model_id: "grok-4.5",
        reasoning_effort: "max",
      }),
    );

    expect(
      readGrokSubagentDiskMeta({
        childSessionId: childId,
        cwd,
        env: { GROK_HOME: grokHome },
        canonicalReasoningEffort: CANONICAL,
      }),
    ).toEqual({
      model: "grok-4.5",
      thinkingOptionId: "xhigh",
    });
  });

  test("falls back to shallow sessions walk when cwd encoding differs", () => {
    const grokHome = mkdtempSync(join(tmpdir(), "paseo-grok-meta-walk-"));
    tempDirs.push(grokHome);
    const childId = "child-session-2";
    const summaryDir = join(grokHome, "sessions", "hashed-cwd-epoch", childId);
    mkdirSync(summaryDir, { recursive: true });
    writeFileSync(
      join(summaryDir, "summary.json"),
      JSON.stringify({
        current_model_id: "grok-code",
        reasoning_effort: "low",
      }),
    );

    expect(
      readGrokSubagentDiskMeta({
        childSessionId: childId,
        cwd: "/some/other/cwd",
        env: { GROK_HOME: grokHome },
        canonicalReasoningEffort: CANONICAL,
      }),
    ).toEqual({
      model: "grok-code",
      thinkingOptionId: "low",
    });
  });

  test("returns null when summary is missing or unreadable", () => {
    const grokHome = mkdtempSync(join(tmpdir(), "paseo-grok-meta-miss-"));
    tempDirs.push(grokHome);
    expect(
      readGrokSubagentDiskMeta({
        childSessionId: "missing",
        cwd: "/workspace",
        env: { GROK_HOME: grokHome },
        canonicalReasoningEffort: CANONICAL,
      }),
    ).toBeNull();
  });
});
