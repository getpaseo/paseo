import { fileURLToPath } from "node:url";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { findUserMessageTurnIndex } from "./codex-user-message-turn-index.js";

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "codex",
  "test-fixtures",
  "rollouts",
  "user-message-turns.jsonl",
);

describe("Codex rollout user-message turn index", () => {
  test("finds the zero-based turn index for a rollout user message id", async () => {
    await expect(findUserMessageTurnIndex(fixturePath, "paseo-user-1")).resolves.toBe(0);
    await expect(findUserMessageTurnIndex(fixturePath, "paseo-user-2")).resolves.toBe(1);
    await expect(findUserMessageTurnIndex(fixturePath, "paseo-user-3")).resolves.toBe(2);
  });

  test("returns null when the rollout does not contain the user message id", async () => {
    await expect(findUserMessageTurnIndex(fixturePath, "missing-user-message")).resolves.toBeNull();
  });
});
