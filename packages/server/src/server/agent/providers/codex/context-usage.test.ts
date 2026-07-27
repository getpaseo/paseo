import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  extractCodexContextUsageFromInfo,
  readCodexContextUsageFromRollout,
  resolveCodexRolloutFile,
} from "./context-usage.js";

async function readSessionUsage(codexHome: string, sessionId: string) {
  const path = await resolveCodexRolloutFile(codexHome, sessionId);
  return path ? readCodexContextUsageFromRollout(path) : null;
}

const SESSION_ID = "019f901a-09c3-7502-adac-c134c101c86d";

function tokenCountLine(info: Record<string, unknown>): string {
  return `${JSON.stringify({
    timestamp: "2026-07-23T18:49:01.655Z",
    type: "event_msg",
    payload: { type: "token_count", info },
  })}\n`;
}

async function writeRollout(codexHome: string, sessionId: string, body: string): Promise<void> {
  const dir = join(codexHome, "sessions", "2026", "07", "24");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `rollout-2026-07-24T01-50-53-${sessionId}.jsonl`), body);
}

describe("extractCodexContextUsageFromInfo", () => {
  test("reads model_context_window and last-turn totals", () => {
    expect(
      extractCodexContextUsageFromInfo({
        model_context_window: 258_400,
        last_token_usage: { total_tokens: 126_174 },
      }),
    ).toEqual({ contextWindowMaxTokens: 258_400, contextWindowUsedTokens: 126_174 });
  });

  test("falls back to a `last` key and camelCase totals", () => {
    expect(
      extractCodexContextUsageFromInfo({
        modelContextWindow: 200_000,
        last: { totalTokens: 5_000 },
      }),
    ).toEqual({ contextWindowMaxTokens: 200_000, contextWindowUsedTokens: 5_000 });
  });

  test("returns null when the context window is missing", () => {
    expect(extractCodexContextUsageFromInfo({ last_token_usage: { total_tokens: 10 } })).toBeNull();
  });

  test("returns null for non-object input", () => {
    expect(extractCodexContextUsageFromInfo(undefined)).toBeNull();
    expect(extractCodexContextUsageFromInfo("nope")).toBeNull();
  });
});

describe("resolveCodexRolloutFile + readCodexContextUsageFromRollout", () => {
  test("reads the latest token_count event from the session rollout", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "paseo-codex-usage-"));
    try {
      await writeRollout(
        codexHome,
        SESSION_ID,
        tokenCountLine({
          model_context_window: 258_400,
          last_token_usage: { total_tokens: 1_000 },
        }) +
          tokenCountLine({
            model_context_window: 258_400,
            last_token_usage: { total_tokens: 126_174 },
          }),
      );

      expect(await readSessionUsage(codexHome, SESSION_ID)).toEqual({
        contextWindowMaxTokens: 258_400,
        contextWindowUsedTokens: 126_174,
      });
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  test("finds the last token_count even after a huge trailing line", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "paseo-codex-usage-"));
    try {
      const hugeLine = `${JSON.stringify({ type: "response_item", payload: { text: "x".repeat(300_000) } })}\n`;
      await writeRollout(
        codexHome,
        SESSION_ID,
        tokenCountLine({ model_context_window: 258_400, last_token_usage: { total_tokens: 42 } }) +
          hugeLine,
      );

      expect(await readSessionUsage(codexHome, SESSION_ID)).toEqual({
        contextWindowMaxTokens: 258_400,
        contextWindowUsedTokens: 42,
      });
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  test("returns null when no rollout file matches the session id", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "paseo-codex-usage-"));
    try {
      await writeRollout(codexHome, "019f0000-0000-7000-8000-000000000000", tokenCountLine({}));
      expect(await resolveCodexRolloutFile(codexHome, SESSION_ID)).toBeNull();
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  test("rejects malformed session ids without touching the filesystem", async () => {
    expect(await resolveCodexRolloutFile("/tmp/whatever", "../etc/passwd")).toBeNull();
  });
});
