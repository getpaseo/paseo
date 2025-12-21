import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { readLatestTurnContextModel } from "./codex-agent.js";

describe("readLatestTurnContextModel", () => {
  it("returns the most recent turn_context model from rollout", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-rollout-"));
    const file = path.join(dir, "rollout.jsonl");
    const lines = [
      JSON.stringify({ type: "session_meta", payload: { id: "thread-1" } }),
      JSON.stringify({
        type: "turn_context",
        payload: { model: "gpt-5.1-codex", cwd: "/tmp" },
      }),
      JSON.stringify({
        type: "turn_context",
        payload: { model: "gpt-5.2-codex", cwd: "/tmp" },
      }),
    ];
    await fs.writeFile(file, lines.join("\n"), "utf8");

    const model = await readLatestTurnContextModel(file);
    expect(model).toBe("gpt-5.2-codex");
  });
});
