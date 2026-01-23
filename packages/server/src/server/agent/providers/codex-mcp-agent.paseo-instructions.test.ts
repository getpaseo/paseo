import { describe, expect, test } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { __test__ } from "./codex-mcp-agent.js";
import type { AgentSessionConfig } from "../agent-sdk-types.js";

describe("codex developer-instructions vs paseo prompt instructions", () => {
  test("does not inject Paseo self-identification into developer-instructions", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "codex-rollout-"));
    const rolloutPath = path.join(dir, "rollout.jsonl");

    const entry = {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ input_text: "hello from history" }],
      },
    };

    writeFileSync(rolloutPath, JSON.stringify(entry) + "\n", "utf8");

    const config: AgentSessionConfig = {
      provider: "codex",
      cwd: dir,
      modeId: "auto",
    };

    const payload = __test__.buildCodexMcpConfig(
      config,
      "Hello world",
      "auto",
      undefined,
      rolloutPath
    );

    const dev = payload["developer-instructions"] ?? "";
    expect(dev).toContain("<previous_conversation>");
    expect(dev).toContain("hello from history");
    expect(dev.toLowerCase()).not.toContain("set_title");
    expect(dev.toLowerCase()).not.toContain("set_branch");
    expect(dev.toLowerCase()).not.toContain("you are running under paseo");
  });
});

