import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { CodexAppServerAgentClient } from "./codex-app-server-agent.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { isProviderAvailable } from "../../daemon-e2e/agent-configs.js";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "codex-plan-mode-real-"));
}

describe("Codex app-server provider (real) plan mode", () => {
  let canRun = false;

  beforeAll(async () => {
    canRun = await isProviderAvailable("codex");
  });

  beforeEach((context) => {
    if (!canRun) {
      context.skip();
    }
  });

  test("maps gpt-5.4 markdown plans to a plan tool call instead of todo items", async () => {
    const cwd = tmpCwd();
    const client = new CodexAppServerAgentClient(createTestLogger());

    try {
      const session = await client.createSession({
        provider: "codex",
        cwd,
        modeId: "auto",
        model: "gpt-5.4",
        thinkingOptionId: "medium",
      });

      try {
        await session.setFeature?.("plan_mode", true);

        const result = await session.run(
          "You are in plan mode. Produce a markdown plan with a short heading and exactly 3 bullets for implementing a login screen. Do not ask questions.",
        );

        expect(result.timeline).not.toContainEqual(
          expect.objectContaining({
            type: "todo",
          }),
        );

        const planCall = result.timeline.find(
          (item) => item.type === "tool_call" && item.detail.type === "plan",
        );

        expect(planCall).toBeDefined();
        if (!planCall || planCall.type !== "tool_call" || planCall.detail.type !== "plan") {
          throw new Error("Expected a plan tool call");
        }

        expect(planCall.detail.text).toContain("Login");
        expect(planCall.detail.text).toContain("- ");
        expect(result.finalText).toBe(planCall.detail.text);
      } finally {
        await session.close();
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 240_000);
});
