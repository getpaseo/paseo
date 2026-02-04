import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";

import { CodexAppServerAgentClient } from "./codex-app-server-agent.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";

const CODEX_TEST_MODEL = "gpt-5.1-codex-mini";
const CODEX_TEST_THINKING_OPTION_ID = "low";

function isCodexInstalled(): boolean {
  try {
    const out = execFileSync("which", ["codex"], { encoding: "utf8" }).trim();
    return out.length > 0;
  } catch {
    return false;
  }
}

describe("Codex app-server provider (e2e)", () => {
  test.runIf(isCodexInstalled())("lists models and runs a simple prompt", async () => {
    const client = new CodexAppServerAgentClient(createTestLogger());
    const models = await client.listModels();
    expect(models.some((m) => m.id.includes("gpt-5.1-codex"))).toBe(true);

    const session = await client.createSession({
      provider: "codex",
      cwd: mkdtempSync(path.join(os.tmpdir(), "codex-app-server-e2e-")),
      modeId: "auto",
      model: CODEX_TEST_MODEL,
      thinkingOptionId: CODEX_TEST_THINKING_OPTION_ID,
    });

    const result = await session.run("Say hello in one sentence.");
    expect(result.finalText.length).toBeGreaterThan(0);
    await session.close();
  }, 30000);
});
