import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, test } from "vitest";

import { createGrokContextUsageResolver, resolveGrokHome } from "./grok-context-usage.js";

const SESSION_ID = "019f808f-7cd7-7b80-89b5-36f2b0f71edd";
const CWD = "/workspace/paseo";

describe("createGrokContextUsageResolver", () => {
  test("reads the Grok CLI's local session counters", async () => {
    const grokHome = await mkdtemp(join(tmpdir(), "paseo-grok-context-"));
    const signalsPath = join(
      grokHome,
      "sessions",
      encodeURIComponent(CWD),
      SESSION_ID,
      "signals.json",
    );
    try {
      await mkdir(dirname(signalsPath), { recursive: true });
      await writeFile(
        signalsPath,
        JSON.stringify({ contextTokensUsed: 16_027, contextWindowTokens: 500_000 }),
      );
      expect(existsSync(signalsPath)).toBe(true);

      const resolver = createGrokContextUsageResolver({ env: { GROK_HOME: grokHome } });
      expect(resolveGrokHome({ GROK_HOME: grokHome })).toBe(grokHome);
      expect(resolver({ sessionId: SESSION_ID, cwd: CWD, modelId: "grok-4.5" })).toEqual({
        contextWindowMaxTokens: 500_000,
        contextWindowUsedTokens: 16_027,
      });
    } finally {
      await rm(grokHome, { recursive: true, force: true });
    }
  });

  test("preserves exact ACP context data when it is available", () => {
    const resolver = createGrokContextUsageResolver({
      readSessionSignals: () => {
        throw new Error("local lookup should not run");
      },
    });
    const usage = {
      contextWindowMaxTokens: 500_000,
      contextWindowUsedTokens: 42_000,
    };

    expect(resolver({ sessionId: SESSION_ID, cwd: CWD, modelId: "grok-4.5", usage })).toBe(usage);
  });
});
