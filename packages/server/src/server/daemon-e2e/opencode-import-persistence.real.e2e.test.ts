import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";

import type { AgentPersistenceHandle, AgentTimelineItem } from "../agent/agent-sdk-types.js";
import { OpenCodeAgentClient } from "../agent/providers/opencode-agent.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { isProviderAvailable } from "./agent-configs.js";
import type { FetchRecentProviderSessionEntry } from "../../client/daemon-client.js";

const OPENCODE_REAL_TEST_MODEL = "opencode/big-pickle";
const OPENCODE_REAL_TEST_TIMEOUT_MS = 180_000;

function tmpCwd(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "daemon-real-opencode-import-persistence-"));
  return realpathSync(dir);
}

async function withConnectedOpenCodeDaemon(
  run: (context: { client: DaemonClient }) => Promise<void>,
): Promise<void> {
  const logger = pino({ level: "silent" });
  const daemon = await createTestPaseoDaemon({
    agentClients: { opencode: new OpenCodeAgentClient(logger) },
    logger,
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });

  try {
    await client.connect();
    await client.fetchAgents({
      subscribe: { subscriptionId: `opencode-import-persistence-${randomUUID()}` },
    });
    await run({ client });
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close().catch(() => undefined);
  }
}

function getProviderHandleId(handle: AgentPersistenceHandle): string {
  return String(handle.nativeHandle ?? handle.sessionId);
}

function hasOpenCodeBigPickleModel(models: ReadonlyArray<{ id: string }>): boolean {
  return models.some((model) => model.id === OPENCODE_REAL_TEST_MODEL);
}

function findProviderSessionEntry(
  entries: ReadonlyArray<FetchRecentProviderSessionEntry>,
  providerHandleId: string,
): FetchRecentProviderSessionEntry | undefined {
  return entries.find((entry) => entry.providerHandleId === providerHandleId);
}

async function fetchCanonicalTimeline(
  client: DaemonClient,
  agentId: string,
): Promise<AgentTimelineItem[]> {
  const timeline = await client.fetchAgentTimeline(agentId, {
    direction: "tail",
    limit: 0,
    projection: "canonical",
  });
  return timeline.entries.map((entry) => entry.item);
}

function digestTimeline(items: ReadonlyArray<AgentTimelineItem>): unknown {
  return {
    userText: collectTimelineText(items, "user_message"),
    reasoningText: collectTimelineText(items, "reasoning"),
    assistantText: collectTimelineText(items, "assistant_message"),
    completedToolCalls: items.flatMap((item) => {
      if (item.type !== "tool_call" || item.status !== "completed") {
        return [];
      }
      return [
        {
          callId: item.callId,
          toolName: item.toolName,
          detail: item.detail,
        },
      ];
    }),
  };
}

function collectTimelineText(
  items: ReadonlyArray<AgentTimelineItem>,
  type: "user_message" | "assistant_message" | "reasoning",
): string {
  return items
    .filter((item): item is Extract<AgentTimelineItem, { type: typeof type }> => item.type === type)
    .map((item) => item.text)
    .join("");
}

function collectCompletedShellOutputs(items: ReadonlyArray<AgentTimelineItem>): string[] {
  return items.flatMap((item) => {
    if (item.type !== "tool_call" || item.status !== "completed" || item.detail.type !== "shell") {
      return [];
    }
    return [item.detail.output ?? ""];
  });
}

describe("daemon E2E (real opencode) - persisted import resume", () => {
  let canRun = false;

  beforeAll(async () => {
    canRun = await isProviderAvailable("opencode");
  });

  beforeEach((context) => {
    if (!canRun) {
      context.skip();
    }
  });

  test(
    "imports and resumes a real opencode/big-pickle session from provider persistence",
    async () => {
      const cwd = tmpCwd();
      const rememberedToken = `OPENCODE_SQLITE_IMPORT_TOKEN_${randomUUID().slice(0, 8)}`;
      let providerHandleId = "";
      let sourceTimelineDigest: unknown = null;

      try {
        await withConnectedOpenCodeDaemon(async ({ client }) => {
          const models = await client.listProviderModels("opencode");
          expect(hasOpenCodeBigPickleModel(models.models)).toBe(true);

          const agent = await client.createAgent({
            cwd,
            title: "opencode import persistence source",
            provider: "opencode",
            model: OPENCODE_REAL_TEST_MODEL,
            modeId: "full-access",
            initialPrompt: `Use the bash tool to run exactly: printf '${rememberedToken}'. Then remember that token and reply exactly READY_TO_RESUME ${rememberedToken}.`,
          });

          const finish = await client.waitForFinish(agent.id, OPENCODE_REAL_TEST_TIMEOUT_MS);
          expect(finish.status).toBe("idle");
          expect(finish.lastMessage).toContain("READY_TO_RESUME");
          expect(finish.final?.persistence).toMatchObject({
            provider: "opencode",
            sessionId: expect.stringMatching(/^ses_/),
            nativeHandle: expect.stringMatching(/^ses_/),
            metadata: { cwd },
          });

          providerHandleId = getProviderHandleId(finish.final!.persistence!);
          const sourceTimeline = await fetchCanonicalTimeline(client, agent.id);
          sourceTimelineDigest = digestTimeline(sourceTimeline);
          expect(collectTimelineText(sourceTimeline, "user_message")).toContain(rememberedToken);
          expect(collectCompletedShellOutputs(sourceTimeline)).toEqual([
            expect.stringContaining(rememberedToken),
          ]);
          expect(collectTimelineText(sourceTimeline, "assistant_message")).toContain(
            `READY_TO_RESUME ${rememberedToken}`,
          );
          await client.deleteAgent(agent.id);
        });

        await withConnectedOpenCodeDaemon(async ({ client }) => {
          const recent = await client.fetchRecentProviderSessions({
            cwd,
            providers: ["opencode"],
            limit: 5,
          });
          const persistedEntry = findProviderSessionEntry(recent.entries, providerHandleId);

          expect(persistedEntry).toMatchObject({
            providerId: "opencode",
            providerHandleId,
            cwd,
          });

          const imported = await client.importAgent({
            providerId: "opencode",
            providerHandleId,
            cwd,
          });
          expect(imported).toMatchObject({
            provider: "opencode",
            cwd,
            model: OPENCODE_REAL_TEST_MODEL,
            status: "idle",
            runtimeInfo: {
              model: OPENCODE_REAL_TEST_MODEL,
            },
            persistence: {
              provider: "opencode",
              sessionId: providerHandleId,
            },
          });

          const importedTimeline = await fetchCanonicalTimeline(client, imported.id);
          expect(digestTimeline(importedTimeline)).toEqual(sourceTimelineDigest);

          await client.sendMessage(
            imported.id,
            "What token did I ask you to remember? Reply with only the token.",
          );
          const resumedFinish = await client.waitForFinish(
            imported.id,
            OPENCODE_REAL_TEST_TIMEOUT_MS,
          );
          expect(resumedFinish).toMatchObject({
            status: "idle",
            lastMessage: expect.stringContaining(rememberedToken),
          });

          await client.deleteAgent(imported.id);
        });
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    OPENCODE_REAL_TEST_TIMEOUT_MS * 2,
  );
});
