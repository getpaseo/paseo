import { beforeAll, beforeEach, describe, test, expect } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";

import { OpenCodeAgentClient } from "../agent/providers/opencode-agent.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { isProviderAvailable } from "./agent-configs.js";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-real-opencode-"));
}

function pickOpenCodeModel(
  models: Array<{ id: string }>,
  preferences: string[] = ["gpt-5-nano", "gpt-4.1-nano", "mini", "free"],
): string {
  const preferred = models.find((model) =>
    preferences.some((fragment) => model.id.includes(fragment)),
  );
  return preferred?.id ?? models[0]!.id;
}

async function createHarness(): Promise<{
  client: DaemonClient;
  daemon: Awaited<ReturnType<typeof createTestPaseoDaemon>>;
}> {
  const logger = pino({ level: "silent" });
  const daemon = await createTestPaseoDaemon({
    agentClients: { opencode: new OpenCodeAgentClient(logger) },
    logger,
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  await client.connect();
  await client.fetchAgents({ subscribe: { subscriptionId: "opencode-real" } });
  return { client, daemon };
}

describe("daemon E2E (real opencode) - plan mode and clarifying questions", () => {
  let canRun = false;

  beforeAll(async () => {
    canRun = await isProviderAvailable("opencode");
  });

  beforeEach((context) => {
    if (!canRun) {
      context.skip();
    }
  });

  test("surfaces clarifying questions as pending permissions", async () => {
    const cwd = tmpCwd();
    const { client, daemon } = await createHarness();

    try {
      const modelList = await client.listProviderModels("opencode");
      expect(modelList.models.length).toBeGreaterThan(0);

      const agent = await client.createAgent({
        provider: "opencode",
        cwd,
        title: "OpenCode question regression",
        model: pickOpenCodeModel(modelList.models, ["minimax-m2.5-free", "minimax", "free"]),
        modeId: "plan",
      });

      await client.sendMessage(
        agent.id,
        [
          "Use the question tool/feature to ask me exactly one clarifying question.",
          "Ask this exact question: What kind of project should the plan cover?",
          "Wait for my answer before doing anything else.",
        ].join(" "),
      );

      const snapshotWithQuestion = await client.waitForAgentUpsert(
        agent.id,
        (snapshot) => (snapshot.pendingPermissions?.[0]?.kind ?? null) === "question",
        30_000,
      );

      expect(snapshotWithQuestion.pendingPermissions?.length).toBeGreaterThan(0);

      const permission = snapshotWithQuestion.pendingPermissions?.[0];
      expect(permission).toBeTruthy();
      expect(permission?.kind).toBe("question");
      expect(Array.isArray(permission?.input?.questions)).toBe(true);

      const firstQuestion = permission?.input?.questions?.[0] as { header?: string } | undefined;
      expect(firstQuestion?.header).toBeTruthy();
    } finally {
      await client.close().catch(() => undefined);
      await daemon.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 180_000);

  test("plan mode stays read-only through the daemon path", async () => {
    const cwd = tmpCwd();
    const filePath = path.join(cwd, "plan-mode-output.txt");
    const { client, daemon } = await createHarness();

    try {
      const modelList = await client.listProviderModels("opencode");
      expect(modelList.models.length).toBeGreaterThan(0);

      const agent = await client.createAgent({
        provider: "opencode",
        cwd,
        title: "OpenCode plan mode regression",
        model: pickOpenCodeModel(modelList.models),
        modeId: "plan",
      });

      await client.sendMessage(
        agent.id,
        "Create a file named plan-mode-output.txt in the current directory containing exactly hello.",
      );

      const state = await client.waitForFinish(agent.id, 180_000);
      expect(state.status).toBe("idle");
      expect(existsSync(filePath)).toBe(false);

      const timeline = await client.fetchAgentTimeline(agent.id, {
        direction: "tail",
        limit: 0,
        projection: "projected",
      });
      const toolCalls = timeline.entries.filter((entry) => entry.item.type === "tool_call");
      const assistantText = timeline.entries
        .filter((entry) => entry.item.type === "assistant_message")
        .map((entry) => entry.item.text)
        .join(" ")
        .trim();

      expect(toolCalls).toHaveLength(0);
      expect(assistantText.length).toBeGreaterThan(0);
    } finally {
      await client.close().catch(() => undefined);
      await daemon.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 240_000);
});
