/**
 * Real end-to-end tests for the Antigravity (agy) provider.
 *
 * Run with:
 *   npx vitest run src/server/daemon-e2e/antigravity.real.e2e.test.ts
 *
 * Requires `agy` to be installed and authenticated (`agy login`).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { beforeAll, expect, test } from "vitest";
import pino from "pino";

import type { AgentTimelineItem } from "../agent/agent-sdk-types.js";
import { AntigravityAgentClient } from "../agent/providers/antigravity-agent.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { isCommandAvailable } from "../../utils/executable.js";

process.env.PASEO_SUPERVISED = "0";

async function isProviderAvailable(_provider: string): Promise<boolean> {
  return await isCommandAvailable("agy");
}

const ANTIGRAVITY_TEST_TIMEOUT_MS = 120_000;

function tmpCwd(prefix = "daemon-real-agy-"): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function createAntigravityDaemon() {
  const logger = pino({ level: "silent" });
  return createTestPaseoDaemon({
    agentClients: { antigravity: new AntigravityAgentClient({ logger }) },
    logger,
  });
}

async function withConnectedAntigravityDaemon(
  run: (context: { client: DaemonClient }) => Promise<void>,
): Promise<void> {
  const daemon = await createAntigravityDaemon();
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.1.86",
  });

  try {
    await client.connect();
    await client.fetchAgents({
      subscribe: { subscriptionId: `agy-real-${randomUUID()}` },
    });
    await run({ client });
  } finally {
    await client.close();
    await daemon.close();
  }
}

function extractAssistantText(items: AgentTimelineItem[]): string {
  return items
    .filter(
      (item): item is Extract<AgentTimelineItem, { type: "assistant_message" }> =>
        item.type === "assistant_message",
    )
    .map((item) => item.text)
    .join("\n");
}

beforeAll(async () => {
  const available = await isProviderAvailable("antigravity");
  if (!available) {
    console.warn("Skipping antigravity real e2e tests: agy binary not found or not authenticated");
  }
});

test(
  "provider is available and models/modes are discoverable",
  async () => {
    const available = await isProviderAvailable("antigravity");
    if (!available) {
      console.warn("Skipping: agy not available");
      return;
    }

    await withConnectedAntigravityDaemon(async ({ client }) => {
      const modelsResult = await client.listProviderModels("antigravity");
      expect(modelsResult.provider).toBe("antigravity");
      expect(modelsResult.error).toBeFalsy();
      expect(modelsResult.models).toBeTruthy();
      expect(modelsResult.models!.length).toBeGreaterThan(0);
      expect(modelsResult.models![0].id).toBe("Gemini 3.5 Flash (Medium)");
      expect(modelsResult.models![0].isDefault).toBe(true);

      const modesResult = await client.listProviderModes("antigravity");
      expect(modesResult.provider).toBe("antigravity");
      expect(modesResult.modes).toBeTruthy();
      expect(modesResult.modes!.map((m) => m.id)).toContain("default");
      expect(modesResult.modes!.map((m) => m.id)).toContain("bypass");
      const bypassMode = modesResult.modes!.find((m) => m.id === "bypass");
      expect(bypassMode).toBeDefined();
      expect(bypassMode?.label).toBeTruthy();
    });
  },
  ANTIGRAVITY_TEST_TIMEOUT_MS,
);

test(
  "basic prompt returns a response",
  async () => {
    const available = await isProviderAvailable("antigravity");
    if (!available) {
      console.warn("Skipping: agy not available");
      return;
    }

    const cwd = tmpCwd();
    try {
      await withConnectedAntigravityDaemon(async ({ client }) => {
        const agent = await client.createAgent({
          cwd,
          title: "agy-basic-test",
          provider: "antigravity",
        });

        await client.sendMessage(agent.id, "Reply with exactly one word: PONG");

        const finish = await client.waitForFinish(agent.id, ANTIGRAVITY_TEST_TIMEOUT_MS);
        expect(finish.status).toBe("idle");

        const timeline = await client.fetchAgentTimeline(agent.id, {
          direction: "tail",
          limit: 0,
          projection: "canonical",
        });
        const text = extractAssistantText(timeline.entries.map((e) => e.item));
        expect(text.trim()).toContain("PONG");
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  },
  ANTIGRAVITY_TEST_TIMEOUT_MS,
);

test(
  "session continuity: follow-up turn resumes the conversation",
  async () => {
    const available = await isProviderAvailable("antigravity");
    if (!available) {
      console.warn("Skipping: agy not available");
      return;
    }

    const cwd = tmpCwd();
    const secretToken = `TOKEN_${randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase()}`;

    try {
      await withConnectedAntigravityDaemon(async ({ client }) => {
        const agent = await client.createAgent({
          cwd,
          title: "agy-continuity-test",
          provider: "antigravity",
        });

        // First turn: plant a token
        await client.sendMessage(agent.id, `Remember this token: ${secretToken}`);
        const first = await client.waitForFinish(agent.id, ANTIGRAVITY_TEST_TIMEOUT_MS);
        expect(first.status).toBe("idle");

        // Second turn: ask for it back — only works if conversation was resumed
        await client.sendMessage(
          agent.id,
          "What token did I ask you to remember? Reply with only the token.",
        );
        const second = await client.waitForFinish(agent.id, ANTIGRAVITY_TEST_TIMEOUT_MS);
        expect(second.status).toBe("idle");

        const timeline = await client.fetchAgentTimeline(agent.id, {
          direction: "tail",
          limit: 5,
          projection: "canonical",
        });
        const text = extractAssistantText(timeline.entries.map((e) => e.item));
        expect(text).toContain(secretToken);
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  },
  ANTIGRAVITY_TEST_TIMEOUT_MS,
);

test(
  "identifies as Gemini when asked about its model",
  async () => {
    const available = await isProviderAvailable("antigravity");
    if (!available) {
      console.warn("Skipping: agy not available");
      return;
    }

    const cwd = tmpCwd();
    try {
      await withConnectedAntigravityDaemon(async ({ client }) => {
        const agent = await client.createAgent({
          cwd,
          title: "agy-model-test",
          provider: "antigravity",
        });

        await client.sendMessage(
          agent.id,
          "What model or AI system are you? Reply in one short sentence.",
        );

        const finish = await client.waitForFinish(agent.id, ANTIGRAVITY_TEST_TIMEOUT_MS);
        expect(finish.status).toBe("idle");

        const timeline = await client.fetchAgentTimeline(agent.id, {
          direction: "tail",
          limit: 0,
          projection: "canonical",
        });
        const text = extractAssistantText(timeline.entries.map((e) => e.item));
        // agy identifies as Antigravity (a Google DeepMind agentic coding assistant)
        expect(text.toLowerCase()).toMatch(/antigravity|gemini|google/i);
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  },
  ANTIGRAVITY_TEST_TIMEOUT_MS,
);
