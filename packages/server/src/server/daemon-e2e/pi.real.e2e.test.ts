import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import pino from "pino";

import type { AgentPersistenceHandle, AgentTimelineItem } from "../agent/agent-sdk-types.js";
import { PiDirectAgentClient } from "../agent/providers/pi-direct-agent.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { isProviderAvailable } from "./agent-configs.js";

process.env.PASEO_SUPERVISED = "0";

const PI_TEST_TIMEOUT_MS = 240_000;
const PI_SUITE_TIMEOUT_MS = 600_000;
const PI_REAL_TEST_MODEL = "openrouter/google/gemini-2.5-flash-lite";

type ToolCallItem = Extract<AgentTimelineItem, { type: "tool_call" }>;

function tmpCwd(prefix = "daemon-real-pi-"): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function createPiClient(): PiDirectAgentClient {
  return new PiDirectAgentClient({ logger: pino({ level: "silent" }) });
}

function createPiToolDaemon() {
  const logger = pino({ level: "silent" });
  return createTestPaseoDaemon({
    agentClients: { pi: new PiDirectAgentClient({ logger }) },
    logger,
  });
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

function extractCompletedToolCalls(items: AgentTimelineItem[]): ToolCallItem[] {
  return items.filter(
    (item): item is ToolCallItem => item.type === "tool_call" && item.status === "completed",
  );
}

function findCompletedToolCall(
  items: AgentTimelineItem[],
  predicate: (item: ToolCallItem) => boolean,
): ToolCallItem | undefined {
  return extractCompletedToolCalls(items).find(predicate);
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

async function withConnectedPiDaemon(
  run: (context: { client: DaemonClient }) => Promise<void>,
): Promise<void> {
  const daemon = await createPiToolDaemon();
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });

  try {
    await client.connect();
    await client.fetchAgents({
      subscribe: { subscriptionId: `pi-real-${randomUUID()}` },
    });
    await run({ client });
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close().catch(() => undefined);
  }
}

describe(
  "daemon E2E (real pi)",
  () => {
    let canRun = false;

    beforeAll(async () => {
      canRun = await isProviderAvailable("pi");
    });

    beforeEach((context) => {
      if (!canRun) {
        context.skip();
      }
    });

    test(
      "bash tool call records completed shell detail and output",
      async () => {
        const cwd = tmpCwd();

        try {
          await withConnectedPiDaemon(async ({ client }) => {
            const agent = await client.createAgent({
              cwd,
              title: "pi-bash-tool-call",
              provider: "pi",
              model: PI_REAL_TEST_MODEL,
            });

            await client.sendMessage(
              agent.id,
              "Use the bash tool and run this exact bash command: echo HELLO_PI_TEST",
            );

            const finish = await client.waitForFinish(agent.id, PI_TEST_TIMEOUT_MS);
            expect(finish.status).toBe("idle");

            const items = await fetchCanonicalTimeline(client, agent.id);
            const toolCall = findCompletedToolCall(
              items,
              (item) =>
                item.detail.type === "shell" && item.detail.command.includes("echo HELLO_PI_TEST"),
            );

            expect(toolCall).toBeDefined();
            expect(toolCall?.status).toBe("completed");
            expect(toolCall?.detail.type).toBe("shell");
            if (toolCall?.detail.type === "shell") {
              expect(toolCall.detail.command).toContain("echo HELLO_PI_TEST");
              expect(toolCall.detail.output).toContain("HELLO_PI_TEST");
            }
          });
        } finally {
          rmSync(cwd, { recursive: true, force: true });
        }
      },
      PI_TEST_TIMEOUT_MS,
    );

    test(
      "file read tool call captures read detail and content",
      async () => {
        const cwd = tmpCwd();
        const filename = "pi-read.txt";
        const expectedContent = "PI_READ_CONTENT_12345";

        try {
          writeFileSync(path.join(cwd, filename), expectedContent, "utf8");

          await withConnectedPiDaemon(async ({ client }) => {
            const agent = await client.createAgent({
              cwd,
              title: "pi-file-read",
              provider: "pi",
              model: PI_REAL_TEST_MODEL,
            });

            await client.sendMessage(
              agent.id,
              `Use the read tool to read the file ${filename} and tell me its contents exactly.`,
            );

            const finish = await client.waitForFinish(agent.id, PI_TEST_TIMEOUT_MS);
            expect(finish.status).toBe("idle");

            const items = await fetchCanonicalTimeline(client, agent.id);
            const toolCall = findCompletedToolCall(
              items,
              (item) =>
                item.detail.type === "read" &&
                item.detail.filePath.includes(filename) &&
                item.detail.content?.includes(expectedContent) === true,
            );

            expect(toolCall).toBeDefined();
            expect(toolCall?.detail.type).toBe("read");
            if (toolCall?.detail.type === "read") {
              expect(toolCall.detail.filePath).toContain(filename);
              expect(toolCall.detail.content).toContain(expectedContent);
            }
          });
        } finally {
          rmSync(cwd, { recursive: true, force: true });
        }
      },
      PI_TEST_TIMEOUT_MS,
    );

    test(
      "file write tool call captures write detail and writes to disk",
      async () => {
        const cwd = tmpCwd();
        const filename = "pi-test-write.txt";
        const expectedContent = "PI_WRITE_CONTENT_67890";

        try {
          await withConnectedPiDaemon(async ({ client }) => {
            const agent = await client.createAgent({
              cwd,
              title: "pi-file-write",
              provider: "pi",
              model: PI_REAL_TEST_MODEL,
            });

            await client.sendMessage(
              agent.id,
              `Use the write tool to write a file called ${filename} in the current directory with the exact content ${expectedContent}`,
            );

            const finish = await client.waitForFinish(agent.id, PI_TEST_TIMEOUT_MS);
            expect(finish.status).toBe("idle");

            const items = await fetchCanonicalTimeline(client, agent.id);
            const toolCall = findCompletedToolCall(
              items,
              (item) => item.detail.type === "write" && item.detail.filePath.includes(filename),
            );

            expect(toolCall).toBeDefined();
            expect(toolCall?.detail.type).toBe("write");
            expect(existsSync(path.join(cwd, filename))).toBe(true);
            expect(readFileSync(path.join(cwd, filename), "utf8")).toBe(expectedContent);
          });
        } finally {
          rmSync(cwd, { recursive: true, force: true });
        }
      },
      PI_TEST_TIMEOUT_MS,
    );

    test(
      "file edit tool call captures edit detail and updates the file on disk",
      async () => {
        const cwd = tmpCwd();
        const filename = "pi-edit.txt";
        const filePath = path.join(cwd, filename);

        try {
          writeFileSync(filePath, "BEFORE_EDIT", "utf8");

          await withConnectedPiDaemon(async ({ client }) => {
            const agent = await client.createAgent({
              cwd,
              title: "pi-file-edit",
              provider: "pi",
              model: PI_REAL_TEST_MODEL,
            });

            await client.sendMessage(
              agent.id,
              `Use the edit tool on the file ${filename} and replace BEFORE_EDIT with AFTER_EDIT. Do not just describe the change.`,
            );

            const finish = await client.waitForFinish(agent.id, PI_TEST_TIMEOUT_MS);
            expect(finish.status).toBe("idle");

            const items = await fetchCanonicalTimeline(client, agent.id);
            const toolCall = findCompletedToolCall(
              items,
              (item) => item.detail.type === "edit" && item.detail.filePath.includes(filename),
            );

            expect(toolCall).toBeDefined();
            expect(toolCall?.detail.type).toBe("edit");
            expect(readFileSync(filePath, "utf8")).toContain("AFTER_EDIT");
          });
        } finally {
          rmSync(cwd, { recursive: true, force: true });
        }
      },
      PI_TEST_TIMEOUT_MS,
    );

    test(
      "thinking-enabled runs emit reasoning timeline chunks",
      async () => {
        const cwd = tmpCwd();

        try {
          await withConnectedPiDaemon(async ({ client }) => {
            const agent = await client.createAgent({
              cwd,
              title: "pi-reasoning",
              provider: "pi",
              model: PI_REAL_TEST_MODEL,
              thinkingOptionId: "high",
            });

            await client.sendMessage(
              agent.id,
              "Think step by step about what 7 * 13 equals, and give the final answer at the end.",
            );

            const finish = await client.waitForFinish(agent.id, PI_TEST_TIMEOUT_MS);
            expect(finish.status).toBe("idle");

            const items = await fetchCanonicalTimeline(client, agent.id);
            const reasoningItems = items.filter(
              (item): item is Extract<AgentTimelineItem, { type: "reasoning" }> =>
                item.type === "reasoning" && item.text.trim().length > 0,
            );

            expect(reasoningItems.length).toBeGreaterThan(0);
          });
        } finally {
          rmSync(cwd, { recursive: true, force: true });
        }
      },
      PI_TEST_TIMEOUT_MS,
    );

    test(
      "session persistence survives delete and resume",
      async () => {
        const cwd = tmpCwd();
        const rememberedToken = "PERSISTENCE_TOKEN_42";

        try {
          await withConnectedPiDaemon(async ({ client }) => {
            const agent = await client.createAgent({
              cwd,
              title: "pi-persistence",
              provider: "pi",
              model: PI_REAL_TEST_MODEL,
            });

            await client.sendMessage(agent.id, `Remember this code: ${rememberedToken}`);

            const initialFinish = await client.waitForFinish(agent.id, PI_TEST_TIMEOUT_MS);
            expect(initialFinish.status).toBe("idle");
            expect(initialFinish.final?.persistence).toBeTruthy();

            const handle = initialFinish.final?.persistence as AgentPersistenceHandle;
            await client.deleteAgent(agent.id);

            const resumed = await client.resumeAgent(handle);
            await client.sendMessage(resumed.id, "What was the code I asked you to remember?");

            const resumedFinish = await client.waitForFinish(resumed.id, PI_TEST_TIMEOUT_MS);
            expect(resumedFinish.status).toBe("idle");

            const items = await fetchCanonicalTimeline(client, resumed.id);
            const assistantText = extractAssistantText(items).toUpperCase();
            expect(assistantText.includes(rememberedToken) || assistantText.includes("42")).toBe(
              true,
            );
          });
        } finally {
          rmSync(cwd, { recursive: true, force: true });
        }
      },
      PI_TEST_TIMEOUT_MS,
    );

    test(
      "PiDirectAgentClient.listModels returns non-empty Pi model definitions",
      async () => {
        const client = createPiClient();
        const models = await client.listModels();

        expect(models.length).toBeGreaterThan(0);
        for (const model of models) {
          expect(model.provider).toBe("pi");
          expect(typeof model.id).toBe("string");
          expect(model.id.length).toBeGreaterThan(0);
          expect(typeof model.label).toBe("string");
          expect(model.label.length).toBeGreaterThan(0);
        }
      },
      PI_TEST_TIMEOUT_MS,
    );

    test(
      "session getRuntimeInfo reflects configured high thinking level",
      async () => {
        const cwd = tmpCwd("pi-runtime-info-");
        const client = createPiClient();

        try {
          const session = await client.createSession({
            provider: "pi",
            cwd,
            thinkingOptionId: "high",
          });

          try {
            const runtimeInfo = await session.getRuntimeInfo();
            expect(runtimeInfo.thinkingOptionId).toBe("high");
          } finally {
            await session.close();
          }
        } finally {
          rmSync(cwd, { recursive: true, force: true });
        }
      },
      PI_TEST_TIMEOUT_MS,
    );

    test(
      "session setThinkingOption('low') updates runtime thinking level",
      async () => {
        const cwd = tmpCwd("pi-feature-");
        const client = createPiClient();

        try {
          const session = await client.createSession({
            provider: "pi",
            cwd,
          });

          try {
            await session.setThinkingOption?.("low");
            const runtimeInfo = await session.getRuntimeInfo();
            expect(runtimeInfo.thinkingOptionId).toBe("low");
          } finally {
            await session.close();
          }
        } finally {
          rmSync(cwd, { recursive: true, force: true });
        }
      },
      PI_TEST_TIMEOUT_MS,
    );
  },
  PI_SUITE_TIMEOUT_MS,
);
