import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, expect, test } from "vitest";
import pino from "pino";

import type {
  AgentClient,
  AgentPersistenceHandle,
  AgentStreamEvent,
  AgentTimelineItem,
} from "../agent/agent-sdk-types.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import {
  canRunRealProvider,
  createRealProviderClient,
  createRealProviderClients,
  getRealProviderConfig,
} from "./real-provider-test-config.js";

process.env.PASEO_SUPERVISED = "0";

const PI_TEST_TIMEOUT_MS = 240_000;
const PI_REAL_TEST_MODEL = getRealProviderConfig("pi").model;
const PI_COMPACTION_TEST_MODEL = PI_REAL_TEST_MODEL.startsWith("openai-codex/")
  ? "openai-codex/gpt-5.4-mini"
  : PI_REAL_TEST_MODEL;
const PI_COMPACTION_RESERVE_TOKENS =
  PI_COMPACTION_TEST_MODEL === PI_REAL_TEST_MODEL ? 126_000 : 270_000;

type ToolCallItem = Extract<AgentTimelineItem, { type: "tool_call" }>;

function tmpCwd(prefix = "daemon-real-pi-"): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writePiCompactionSettings(
  cwd: string,
  compaction: { enabled: boolean; reserveTokens?: number; keepRecentTokens?: number },
): void {
  mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  writeFileSync(path.join(cwd, ".pi/settings.json"), JSON.stringify({ compaction }, null, 2));
}

function createPiClient(): AgentClient {
  return createRealProviderClient("pi", pino({ level: "silent" }));
}

function createPiToolDaemon() {
  const logger = pino({ level: "silent" });
  return createTestPaseoDaemon({
    agentClients: createRealProviderClients(["pi"], logger),
    logger,
  });
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

async function waitForTimelineItem(
  client: DaemonClient,
  agentId: string,
  predicate: (item: AgentTimelineItem) => boolean,
  timeoutMs = PI_TEST_TIMEOUT_MS,
): Promise<AgentTimelineItem> {
  const deadline = Date.now() + timeoutMs;
  let lastItems: AgentTimelineItem[] = [];
  while (Date.now() < deadline) {
    lastItems = await fetchCanonicalTimeline(client, agentId);
    const item = lastItems.find(predicate);
    if (item) {
      return item;
    }
    await sleep(250);
  }
  throw new Error(
    `Timed out waiting for Pi timeline item. Last timeline: ${JSON.stringify(lastItems)}`,
  );
}

async function withConnectedPiDaemon(
  run: (context: { client: DaemonClient; daemon: TestPaseoDaemon }) => Promise<void>,
): Promise<void> {
  const daemon = await createPiToolDaemon();
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.1.45",
  });

  try {
    await client.connect();
    await client.fetchAgents({
      subscribe: { subscriptionId: `pi-real-${randomUUID()}` },
    });
    await run({ client, daemon });
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close().catch(() => undefined);
  }
}

let canRun = false;

beforeAll(async () => {
  canRun = await canRunRealProvider("pi");
});

beforeEach((context) => {
  if (!canRun) {
    context.skip();
  }
});

test(
  "real Pi daemon composes project and Paseo system prompts",
  async () => {
    const cwd = tmpCwd("pi-system-prompts-");

    try {
      mkdirSync(path.join(cwd, ".pi"), { recursive: true });
      writeFileSync(
        path.join(cwd, ".pi", "APPEND_SYSTEM.md"),
        [
          "When the user says PASEO_SYSTEM_PROMPT_PROBE, reply with exactly two tokens:",
          "PROJECT_PROMPT followed by the value of PASEO_PROMPT_TOKEN from later system instructions.",
          "If no PASEO_PROMPT_TOKEN exists, use MISSING as the second token.",
        ].join("\n"),
      );

      await withConnectedPiDaemon(async ({ client }) => {
        const agent = await client.createAgent({
          cwd,
          title: "pi-system-prompts",
          provider: "pi",
          model: PI_REAL_TEST_MODEL,
          systemPrompt:
            "PASEO_PROMPT_TOKEN is PASEO_PROMPT. Follow the project instruction for PASEO_SYSTEM_PROMPT_PROBE.",
        });

        await client.sendMessage(agent.id, "PASEO_SYSTEM_PROMPT_PROBE");
        const finish = await client.waitForFinish(agent.id, PI_TEST_TIMEOUT_MS);
        expect(finish.status).toBe("idle");

        const items = await fetchCanonicalTimeline(client, agent.id);
        const response = items
          .filter((item) => item.type === "assistant_message")
          .map((item) => item.text)
          .join("")
          .trim();
        expect(response).toBe("PROJECT_PROMPT PASEO_PROMPT");
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  },
  PI_TEST_TIMEOUT_MS,
);

test(
  "real Pi daemon lists Paseo-handled compact slash commands",
  async () => {
    const cwd = tmpCwd("pi-compact-commands-");

    try {
      await withConnectedPiDaemon(async ({ client }) => {
        const agent = await client.createAgent({
          cwd,
          title: "pi-compact-commands",
          provider: "pi",
          model: PI_REAL_TEST_MODEL,
        });

        const result = await client.listCommands({ agentId: agent.id });
        expect(result.commands).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: "compact",
              description: "Manually compact the session context",
            }),
            expect.objectContaining({
              name: "autocompact",
              description: "Toggle automatic context compaction",
            }),
          ]),
        );
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  },
  PI_TEST_TIMEOUT_MS,
);

test(
  "real Pi daemon executes manual compact out-of-band instead of prompt text",
  async () => {
    const cwd = tmpCwd("pi-manual-compact-");

    try {
      writePiCompactionSettings(cwd, {
        enabled: true,
        keepRecentTokens: 1,
      });

      await withConnectedPiDaemon(async ({ client }) => {
        const agent = await client.createAgent({
          cwd,
          title: "pi-manual-compact",
          provider: "pi",
          model: PI_COMPACTION_TEST_MODEL,
        });

        await client.sendMessage(agent.id, "Reply exactly: compact-ready");
        const finish = await client.waitForFinish(agent.id, PI_TEST_TIMEOUT_MS);
        expect(finish.status).toBe("idle");

        await client.sendMessage(agent.id, "/compact summarize this e2e run");

        await waitForTimelineItem(
          client,
          agent.id,
          (item) => item.type === "compaction" && item.status === "completed",
        );

        const items = await fetchCanonicalTimeline(client, agent.id);
        expect(items).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: "compaction",
              status: "loading",
              trigger: "manual",
            }),
            expect.objectContaining({
              type: "compaction",
              status: "completed",
            }),
          ]),
        );
        expect(
          items.some((item) => item.type === "user_message" && item.text.includes("/compact")),
        ).toBe(false);
        expect(
          items
            .filter((item) => item.type === "assistant_message")
            .map((item) => item.text)
            .filter((text) => text.includes("Failed to compact")),
        ).toEqual([]);
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  },
  PI_TEST_TIMEOUT_MS,
);

test(
  "real Pi daemon toggles auto-compaction out-of-band instead of prompt text",
  async () => {
    const cwd = tmpCwd("pi-autocompact-toggle-");

    try {
      await withConnectedPiDaemon(async ({ client }) => {
        const agent = await client.createAgent({
          cwd,
          title: "pi-autocompact-toggle",
          provider: "pi",
          model: PI_COMPACTION_TEST_MODEL,
        });

        await client.sendMessage(agent.id, "/autocompact off");
        await waitForTimelineItem(
          client,
          agent.id,
          (item) => item.type === "assistant_message" && item.text === "Auto-compaction disabled.",
        );

        await client.sendMessage(agent.id, "/autocompact");
        await waitForTimelineItem(
          client,
          agent.id,
          (item) => item.type === "assistant_message" && item.text === "Auto-compaction enabled.",
        );

        const items = await fetchCanonicalTimeline(client, agent.id);
        expect(
          items.some((item) => item.type === "user_message" && item.text.includes("/autocompact")),
        ).toBe(false);
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  },
  PI_TEST_TIMEOUT_MS,
);

test(
  "real Pi daemon surfaces automatic threshold compaction events",
  async () => {
    const cwd = tmpCwd("pi-auto-compact-");

    try {
      writePiCompactionSettings(cwd, {
        enabled: true,
        reserveTokens: PI_COMPACTION_RESERVE_TOKENS,
        keepRecentTokens: 1,
      });

      await withConnectedPiDaemon(async ({ client }) => {
        const agent = await client.createAgent({
          cwd,
          title: "pi-auto-compact",
          provider: "pi",
          model: PI_COMPACTION_TEST_MODEL,
        });

        await client.sendMessage(agent.id, "Reply exactly: auto-compact-ready");
        const finish = await client.waitForFinish(agent.id, PI_TEST_TIMEOUT_MS);
        expect(finish.status, JSON.stringify(finish)).toBe("idle");

        await waitForTimelineItem(
          client,
          agent.id,
          (item) => item.type === "compaction" && item.status === "completed",
        );

        const items = await fetchCanonicalTimeline(client, agent.id);
        expect(items).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: "compaction",
              status: "loading",
              trigger: "auto",
            }),
            expect.objectContaining({
              type: "compaction",
              status: "completed",
            }),
          ]),
        );
        expect(
          items.some(
            (item) =>
              item.type === "assistant_message" && item.text.includes("Auto-compaction failed"),
          ),
        ).toBe(false);
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  },
  PI_TEST_TIMEOUT_MS,
);

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
          "Work out 37 * 43 carefully, then answer with only the number.",
        );

        const finish = await client.waitForFinish(agent.id, PI_TEST_TIMEOUT_MS);
        expect(finish.status).toBe("idle");

        const items = await fetchCanonicalTimeline(client, agent.id);
        const reasoningItems = items.filter(
          (item): item is Extract<AgentTimelineItem, { type: "reasoning" }> =>
            item.type === "reasoning" && item.text.trim().length > 0,
        );
        const assistantTexts = items
          .filter(
            (item): item is Extract<AgentTimelineItem, { type: "assistant_message" }> =>
              item.type === "assistant_message",
          )
          .map((item) => item.text);

        expect(assistantTexts.join("\n")).toContain("1591");
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
        expect(resumed.provider).toBe("pi");
        expect(resumed.cwd).toBe(cwd);

        await client.sendMessage(resumed.id, "Reply with exactly: resumed");

        const resumedFinish = await client.waitForFinish(resumed.id, PI_TEST_TIMEOUT_MS);
        expect(resumedFinish.status).toBe("idle");
        expect(resumedFinish.final?.persistence).toBeTruthy();
        expect(resumedFinish.final?.persistence?.provider).toBe("pi");
        expect(resumedFinish.final?.persistence?.nativeHandle).toBe(handle.nativeHandle);
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  },
  PI_TEST_TIMEOUT_MS,
);

test(
  "resumed Pi prompts retain their exact native entry ids after idle collection",
  async () => {
    const cwd = tmpCwd("pi-resumed-entry-id-");
    const firstPrompt = "PASEO_PI_ENTRY_ID_FIRST. Reply exactly: first-ok";
    const secondPrompt = "PASEO_PI_ENTRY_ID_SECOND. Reply exactly: second-ok";

    try {
      await withConnectedPiDaemon(async ({ client, daemon }) => {
        const agent = await client.createAgent({
          cwd,
          title: "pi-resumed-entry-id",
          provider: "pi",
          model: PI_REAL_TEST_MODEL,
        });

        await client.sendMessage(agent.id, firstPrompt);
        const firstFinish = await client.waitForFinish(agent.id, PI_TEST_TIMEOUT_MS);
        expect(firstFinish.status).toBe("idle");

        const collection = await daemon.daemon.agentManager.collectIdleAgents({
          cutoff: new Date(Date.now() + 1_000),
          protectedAgentIds: new Set(),
        });
        expect(collection.failures).toEqual([]);
        expect(collection.collected.map((entry) => entry.agentId)).toContain(agent.id);

        await client.sendMessage(agent.id, secondPrompt);
        const secondFinish = await client.waitForFinish(agent.id, PI_TEST_TIMEOUT_MS);
        expect(secondFinish.status).toBe("idle");

        const nativeHandle = secondFinish.final?.persistence?.nativeHandle;
        if (typeof nativeHandle !== "string") {
          throw new Error("Real Pi run did not return a native session file");
        }
        const nativeUserEntryIds = readFileSync(nativeHandle, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Record<string, unknown>)
          .filter(
            (entry) =>
              entry.type === "message" &&
              typeof entry.id === "string" &&
              typeof entry.message === "object" &&
              entry.message !== null &&
              (entry.message as { role?: unknown }).role === "user",
          )
          .map((entry) => entry.id as string);
        const userMessages = (await fetchCanonicalTimeline(client, agent.id)).filter(
          (item): item is Extract<AgentTimelineItem, { type: "user_message" }> =>
            item.type === "user_message",
        );

        expect(userMessages.map((item) => item.text)).toEqual([firstPrompt, secondPrompt]);
        expect(userMessages.map((item) => item.messageId)).toEqual(nativeUserEntryIds);
        expect(new Set(nativeUserEntryIds).size).toBe(2);
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  },
  PI_TEST_TIMEOUT_MS * 2,
);

test(
  "streamHistory replays user and assistant timeline after resume",
  async () => {
    const cwd = tmpCwd("pi-history-prime-");
    const marker = "HISTORY_PRIME_MARKER_4242";

    const piClient = createPiClient();
    const session = await piClient.createSession({
      provider: "pi",
      cwd,
      model: PI_REAL_TEST_MODEL,
    });

    let handle: AgentPersistenceHandle | null = null;

    try {
      const result = await session.run(`Reply with exactly this token and nothing else: ${marker}`);
      expect(result.finalText).toContain(marker);

      handle = session.describePersistence();
      expect(handle).toBeTruthy();
    } finally {
      await session.close();
    }

    const resumed = await piClient.resumeSession(handle as AgentPersistenceHandle);

    try {
      const events: AgentStreamEvent[] = [];
      for await (const event of resumed.streamHistory()) {
        events.push(event);
      }

      const items = events
        .filter(
          (event): event is Extract<AgentStreamEvent, { type: "timeline" }> =>
            event.type === "timeline",
        )
        .map((event) => event.item);

      const userItems = items.filter(
        (item): item is Extract<AgentTimelineItem, { type: "user_message" }> =>
          item.type === "user_message",
      );
      expect(userItems.length).toBeGreaterThan(0);
      expect(userItems.some((item) => item.text.includes(marker))).toBe(true);
      expect(userItems.every((item) => typeof item.messageId === "string")).toBe(true);

      const assistantItems = items.filter(
        (item): item is Extract<AgentTimelineItem, { type: "assistant_message" }> =>
          item.type === "assistant_message",
      );
      expect(assistantItems.length).toBeGreaterThan(0);
      expect(assistantItems.some((item) => item.text.includes(marker))).toBe(true);
    } finally {
      await resumed.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  },
  PI_TEST_TIMEOUT_MS,
);

test(
  "PiRpcAgentClient.fetchCatalog returns non-empty Pi model definitions",
  async () => {
    const client = createPiClient();
    const cwd = tmpCwd("pi-list-models-");
    try {
      const { models } = await client.fetchCatalog({ scope: "workspace", cwd, force: false });

      expect(models.length).toBeGreaterThan(0);
      for (const model of models) {
        expect(model.provider).toBe("pi");
        expect(typeof model.id).toBe("string");
        expect(model.id.length).toBeGreaterThan(0);
        expect(typeof model.label).toBe("string");
        expect(model.label.length).toBeGreaterThan(0);
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
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
