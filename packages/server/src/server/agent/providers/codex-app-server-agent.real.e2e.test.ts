import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, test } from "vitest";

import type { AgentStreamEvent } from "../agent-sdk-types.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import {
  canRunRealProvider,
  createRealProviderClient,
  getRealProviderConfig,
} from "../../daemon-e2e/real-provider-test-config.js";
import { CodexAppServerAgentClient } from "./codex-app-server-agent.js";

describe("Codex app-server provider (real)", () => {
  let canRunOpenRouter = false;

  beforeAll(async () => {
    canRunOpenRouter = await canRunRealProvider("codex");
  });

  test("lists models and runs a simple prompt", async (context) => {
    if (!canRunOpenRouter) {
      context.skip();
    }
    const client = createRealProviderClient("codex", createTestLogger());
    const cwd = mkdtempSync(path.join(os.tmpdir(), "codex-app-server-e2e-"));
    try {
      const { models } = await client.fetchCatalog({ scope: "workspace", cwd, force: false });
      expect(models.length).toBeGreaterThan(0);
      const session = await client.createSession({
        ...getRealProviderConfig("codex"),
        cwd,
        modeId: "auto",
      });
      try {
        expect(session.features?.some((feature) => feature.id === "plan_mode")).toBe(true);

        const result = await session.run("Say hello in one sentence.");
        expect(result.finalText.length).toBeGreaterThan(0);
      } finally {
        await session.close();
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 30_000);

  test("keeps a real MultiAgentV2 child inside its parent turn", async () => {
    const client = new CodexAppServerAgentClient(createTestLogger());
    const cwd = mkdtempSync(path.join(os.tmpdir(), "codex-multi-agent-v2-e2e-"));
    try {
      const { models } = await client.fetchCatalog({ scope: "workspace", cwd, force: false });
      const model = models.find((candidate) => candidate.isDefault) ?? models[0];
      if (!model) {
        throw new Error("Native Codex app-server returned no models");
      }
      const session = await client.createSession({
        provider: "codex",
        modeId: "full-access",
        model: model.id,
        cwd,
        thinkingOptionId: "medium",
        extra: { codex: { features: { multi_agent_v2: true } } },
      });
      const events: AgentStreamEvent[] = [];
      const unsubscribe = session.subscribe((event) => events.push(event));

      try {
        const result = await session.run(`
Use collaboration.spawn_agent exactly once with task_name "sentinel_child", fork_turns "none",
and this task: "Reply with exactly CHILD_SENTINEL and do nothing else."
Wait for that child to finish with collaboration.wait_agent. Do not emit any assistant text before
the child finishes. After it finishes, reply with exactly ROOT_SENTINEL. Never repeat
CHILD_SENTINEL in your own response.
`);

        const completedChildIndex = events.findIndex(
          (event) =>
            event.type === "timeline" &&
            event.item.type === "tool_call" &&
            event.item.status === "completed" &&
            event.item.detail.type === "sub_agent" &&
            event.item.detail.log.includes("CHILD_SENTINEL"),
        );
        const rootMessageIndexes = events.flatMap((event, index) =>
          event.type === "timeline" && event.item.type === "assistant_message" ? [index] : [],
        );
        const terminalIndexes = events.flatMap((event, index) =>
          event.type === "turn_completed" ||
          event.type === "turn_failed" ||
          event.type === "turn_canceled"
            ? [index]
            : [],
        );

        expect(result.finalText.trim()).toBe("ROOT_SENTINEL");
        expect(
          result.timeline.findLast(
            (item) => item.type === "tool_call" && item.detail.type === "sub_agent",
          ),
        ).toMatchObject({ status: "completed" });
        const topLevelAssistantText = result.timeline
          .filter((item) => item.type === "assistant_message")
          .map((item) => item.text)
          .join("");
        expect(topLevelAssistantText).not.toContain("CHILD_SENTINEL");
        expect(completedChildIndex).toBeGreaterThanOrEqual(0);
        expect(rootMessageIndexes[0]).toBeGreaterThan(completedChildIndex);
        expect(terminalIndexes).toHaveLength(1);
        expect(terminalIndexes[0]).toBeGreaterThan(rootMessageIndexes.at(-1) ?? -1);
      } finally {
        unsubscribe();
        await session.close();
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 300_000);
});
