import { mkdtempSync, rmSync } from "node:fs";
import { readdir, mkdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PiRpcAgentClient } from "../agent/providers/pi/agent.js";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import type { AgentTimelineItem } from "../agent/agent-sdk-types.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { canRunRealProvider, createRealProviderClients } from "./real-provider-test-config.js";
import {
  closeRewindSession,
  fetchTimelineItems,
  tmpRewindCwd,
  userMessageIdForToken,
} from "./test-utils/rewind-helpers.js";

interface PiRewindHarness {
  client: DaemonClient;
  daemon: TestPaseoDaemon;
}

interface PiRewindSession {
  agentId: string;
  cwd: string;
}

const TURN_TIMEOUT_MS = 240_000;
const PI_REAL_TEST_MODEL = "openrouter/google/gemini-2.5-flash-lite";

async function launchPiRewindSession(
  harness: PiRewindHarness,
  title: string,
): Promise<PiRewindSession> {
  const cwd = tmpRewindCwd("daemon-real-pi-rewind-");
  const agent = await harness.client.createAgent({
    cwd,
    title,
    provider: "pi",
    model: PI_REAL_TEST_MODEL,
    thinkingOptionId: "medium",
  });

  return { agentId: agent.id, cwd };
}

async function closePiRewindSession(session: PiRewindSession): Promise<void> {
  closeRewindSession(session);
}

async function runtimeSessionId(
  harness: PiRewindHarness,
  session: PiRewindSession,
): Promise<string> {
  const snapshot = await harness.client.fetchAgent({ agentId: session.agentId });
  const sessionId =
    snapshot?.agent.runtimeInfo?.sessionId ?? snapshot?.agent.persistence?.sessionId;
  if (!sessionId) {
    throw new Error(`Agent ${session.agentId} does not have a visible Pi session id`);
  }
  return sessionId;
}

function expectPiSessionId(value: string): void {
  expect(value.length).toBeGreaterThan(0);
}

interface PiTurn {
  promptToken: string;
  doneToken: string;
  filler?: string;
}

function piPrompt(input: PiTurn): string {
  return [
    `PASEO_PI_REWIND_PROMPT_${input.promptToken}.`,
    "Remember this marker for the conversation.",
    ...(input.filler ? [`Ignore this filler: ${input.filler}`] : []),
    `Reply exactly: ${input.doneToken}`,
  ].join(" ");
}

function turn(token: string): PiTurn {
  return { promptToken: token, doneToken: `PI_${token}_DONE` };
}

// Pi keeps the most recent 20k estimated tokens (4 characters each) when it compacts.
// A turn larger than that makes /compact summarize every turn before it.
function turnOutlastingCompaction(token: string): PiTurn {
  return { ...turn(token), filler: "lorem ipsum ".repeat(8_000) };
}

function roleItems(items: AgentTimelineItem[], role: "user_message" | "assistant_message") {
  return items.filter((item) => item.type === role);
}

function expectTimeline(
  items: AgentTimelineItem[],
  input: { userTexts: string[]; assistantCount: number },
): void {
  const userMessages = roleItems(items, "user_message");
  const assistantMessages = roleItems(items, "assistant_message");

  expect(userMessages).toHaveLength(input.userTexts.length);
  expect(userMessages.map((message) => message.text)).toEqual(input.userTexts);
  expect(assistantMessages).toHaveLength(input.assistantCount);
}

async function expectNoCreatedFiles(session: PiRewindSession): Promise<void> {
  await expect(readdir(session.cwd)).resolves.toEqual([]);
}

async function compactPi(harness: PiRewindHarness, session: PiRewindSession): Promise<void> {
  await harness.client.sendMessage(session.agentId, "/compact");
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const items = await fetchTimelineItems(harness.client, session.agentId);
    const failure = items.find(
      (item) => item.type === "assistant_message" && item.text.includes("Failed to compact"),
    );
    if (failure) {
      throw new Error(`Pi compaction failed: ${JSON.stringify(failure)}`);
    }
    if (items.some((item) => item.type === "compaction" && item.status === "completed")) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Pi compaction did not complete");
}

async function askPi(
  harness: PiRewindHarness,
  session: PiRewindSession,
  input: PiTurn,
): Promise<void> {
  await harness.client.sendMessage(session.agentId, piPrompt(input));
  const finish = await harness.client.waitForFinish(session.agentId, TURN_TIMEOUT_MS);
  expect(finish.status).toBe("idle");
  expect(finish.final?.lastError).toBeUndefined();
}

describe("daemon E2E (real pi) - rewind", () => {
  let canRun = false;
  let harness: PiRewindHarness;

  beforeAll(async () => {
    canRun = await canRunRealProvider("pi");
    if (!canRun) {
      return;
    }
    const logger = pino({ level: "silent" });
    const daemon = await createTestPaseoDaemon({
      agentClients: createRealProviderClients(["pi"], logger),
      logger,
    });
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      appVersion: "0.1.70",
    });

    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    harness = { client, daemon };
  }, 30_000);

  afterAll(async () => {
    await harness?.client.close().catch(() => undefined);
    await harness?.daemon.close().catch(() => undefined);
  });

  beforeEach((context) => {
    if (!canRun) {
      context.skip();
    }
  });

  test("rewinds a real Pi conversation after a single turn and keeps the session usable", async () => {
    if (!harness) throw new Error("Pi rewind harness was not initialized");
    const session = await launchPiRewindSession(harness, "pi-rewind-single-conversation-real");

    try {
      await askPi(harness, session, {
        promptToken: "SINGLE",
        doneToken: "PI_SINGLE_DONE",
      });
      const firstTimeline = await fetchTimelineItems(harness.client, session.agentId);
      const firstMessageId = userMessageIdForToken(firstTimeline, "PI_REWIND_PROMPT_SINGLE");
      const sessionIdBefore = await runtimeSessionId(harness, session);
      expectPiSessionId(sessionIdBefore);

      await harness.client.rewindAgent(session.agentId, firstMessageId, "conversation");
      const sessionIdAfter = await runtimeSessionId(harness, session);
      const rewoundTimeline = await fetchTimelineItems(harness.client, session.agentId);

      expect(sessionIdAfter).toBe(sessionIdBefore);
      expectTimeline(rewoundTimeline, { userTexts: [], assistantCount: 0 });
      await expectNoCreatedFiles(session);

      await askPi(harness, session, {
        promptToken: "AFTER_SINGLE",
        doneToken: "PI_AFTER_SINGLE_DONE",
      });
      const nextTimeline = await fetchTimelineItems(harness.client, session.agentId);

      expectTimeline(nextTimeline, {
        userTexts: [piPrompt({ promptToken: "AFTER_SINGLE", doneToken: "PI_AFTER_SINGLE_DONE" })],
        assistantCount: 1,
      });
      await expectNoCreatedFiles(session);
    } finally {
      await closePiRewindSession(session);
    }
  }, 420_000);

  test("rewinds a real Pi conversation to an earlier user message", async () => {
    const session = await launchPiRewindSession(harness, "pi-rewind-conversation-real");

    try {
      await askPi(harness, session, {
        promptToken: "FIRST",
        doneToken: "PI_FIRST_DONE",
      });
      const firstTimeline = await fetchTimelineItems(harness.client, session.agentId);
      const firstMessageId = userMessageIdForToken(firstTimeline, "PI_REWIND_PROMPT_FIRST");

      await askPi(harness, session, {
        promptToken: "SECOND",
        doneToken: "PI_SECOND_DONE",
      });
      const sessionIdBefore = await runtimeSessionId(harness, session);
      expectPiSessionId(sessionIdBefore);

      await harness.client.rewindAgent(session.agentId, firstMessageId, "conversation");
      const sessionIdAfter = await runtimeSessionId(harness, session);
      const rewoundTimeline = await fetchTimelineItems(harness.client, session.agentId);

      expect(sessionIdAfter).toBe(sessionIdBefore);
      expectTimeline(rewoundTimeline, { userTexts: [], assistantCount: 0 });
      await expectNoCreatedFiles(session);
    } finally {
      await closePiRewindSession(session);
    }
  }, 420_000);

  test("rewinds a replayed row to the selected message after an earlier rewind branched the session", async () => {
    const session = await launchPiRewindSession(harness, "pi-rewind-branched-replay-real");

    try {
      await askPi(harness, session, turn("ONE"));
      await askPi(harness, session, turn("ABANDONED"));
      const abandonedId = userMessageIdForToken(
        await fetchTimelineItems(harness.client, session.agentId),
        "PI_REWIND_PROMPT_ABANDONED",
      );
      await harness.client.rewindAgent(session.agentId, abandonedId, "conversation");

      await askPi(harness, session, turn("TWO"));
      await askPi(harness, session, turn("THREE"));
      await askPi(harness, session, turn("FOUR"));
      const fourId = userMessageIdForToken(
        await fetchTimelineItems(harness.client, session.agentId),
        "PI_REWIND_PROMPT_FOUR",
      );
      await harness.client.rewindAgent(session.agentId, fourId, "conversation");

      const replayedTimeline = await fetchTimelineItems(harness.client, session.agentId);
      expectTimeline(replayedTimeline, {
        userTexts: [piPrompt(turn("ONE")), piPrompt(turn("TWO")), piPrompt(turn("THREE"))],
        assistantCount: 3,
      });
      const replayedThreeId = userMessageIdForToken(replayedTimeline, "PI_REWIND_PROMPT_THREE");
      await harness.client.rewindAgent(session.agentId, replayedThreeId, "conversation");

      expectTimeline(await fetchTimelineItems(harness.client, session.agentId), {
        userTexts: [piPrompt(turn("ONE")), piPrompt(turn("TWO"))],
        assistantCount: 2,
      });
      await expectNoCreatedFiles(session);
    } finally {
      await closePiRewindSession(session);
    }
  }, 900_000);

  test("rewinds a row whose entry an earlier compaction summarized away", async () => {
    const session = await launchPiRewindSession(harness, "pi-rewind-compacted-real");

    try {
      await askPi(harness, session, turn("ONE"));
      await askPi(harness, session, turn("TWO"));
      await askPi(harness, session, turnOutlastingCompaction("THREE"));
      const twoId = userMessageIdForToken(
        await fetchTimelineItems(harness.client, session.agentId),
        "PI_REWIND_PROMPT_TWO",
      );
      await compactPi(harness, session);

      await harness.client.rewindAgent(session.agentId, twoId, "conversation");

      expectTimeline(await fetchTimelineItems(harness.client, session.agentId), {
        userTexts: [piPrompt(turn("ONE"))],
        assistantCount: 1,
      });
      await expectNoCreatedFiles(session);
    } finally {
      await closePiRewindSession(session);
    }
  }, 900_000);

  test("keeps a rewind after the daemon restarts", async () => {
    const cwd = tmpRewindCwd("daemon-real-pi-rewind-");
    const paseoHomeRoot = mkdtempSync(path.join(tmpdir(), "daemon-real-pi-rewind-home-"));
    const logger = pino({ level: "silent" });
    const startDaemon = async (): Promise<PiRewindHarness> => {
      const daemon = await createTestPaseoDaemon({
        agentClients: createRealProviderClients(["pi"], logger),
        logger,
        paseoHomeRoot,
        cleanup: false,
      });
      const client = new DaemonClient({
        url: `ws://127.0.0.1:${daemon.port}/ws`,
      });
      await client.connect();
      await client.fetchAgents({ subscribe: {} });
      return { client, daemon };
    };
    const stopDaemon = async (restarted: PiRewindHarness): Promise<void> => {
      await restarted.client.close().catch(() => undefined);
      await restarted.daemon.close().catch(() => undefined);
    };
    let current = await startDaemon();

    try {
      const agent = await current.client.createAgent({
        cwd,
        title: "pi-rewind-restart-real",
        provider: "pi",
        model: PI_REAL_TEST_MODEL,
        thinkingOptionId: "medium",
      });
      const session = { agentId: agent.id, cwd };
      for (const token of ["ONE", "TWO", "THREE", "FOUR"]) {
        await askPi(current, session, turn(token));
      }
      const threeId = userMessageIdForToken(
        await fetchTimelineItems(current.client, agent.id),
        "PI_REWIND_PROMPT_THREE",
      );
      await current.client.rewindAgent(agent.id, threeId, "conversation");
      const rewound = {
        userTexts: [piPrompt(turn("ONE")), piPrompt(turn("TWO"))],
        assistantCount: 2,
      };
      expectTimeline(await fetchTimelineItems(current.client, agent.id), rewound);

      await stopDaemon(current);
      current = await startDaemon();

      expectTimeline(await fetchTimelineItems(current.client, agent.id), rewound);
    } finally {
      await stopDaemon(current);
      rmSync(paseoHomeRoot, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 900_000);
});

test("seeded compacted Pi history survives daemon reload, native rewind and Fork chat", async (context) => {
  if (!(await canRunRealProvider("pi"))) {
    context.skip();
    return;
  }
  const artifacts = path.resolve(".artifacts/pi-timeline");
  await mkdir(artifacts, { recursive: true });
  const root = await mkdtemp(path.join(artifacts, "daemon-history-"));
  const cwd = path.join(root, "cwd");
  await mkdir(cwd);
  const file = path.join(root, "session.jsonl");
  const nativeId = randomUUID();
  const timestamp = new Date().toISOString();
  const assistant = (text: string) => ({
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "openrouter",
    model: "google/gemini-2.5-flash-lite",
    stopReason: "stop",
    timestamp: Date.now(),
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
  const records = [
    { type: "session", version: 3, id: nativeId, cwd, timestamp },
    {
      type: "message",
      id: "system",
      parentId: null,
      timestamp,
      message: {
        role: "system",
        content: [{ type: "text", text: "private system context" }],
        timestamp: Date.now(),
      },
    },
    {
      type: "message",
      id: "u1",
      parentId: "system",
      timestamp,
      message: { role: "user", content: "old question", timestamp: Date.now() },
    },
    {
      type: "message",
      id: "tool-request",
      parentId: "u1",
      timestamp,
      message: {
        ...assistant(""),
        content: [
          { type: "toolCall", id: "read-call", name: "read", arguments: { path: "readme.txt" } },
        ],
      },
    },
    {
      type: "message",
      id: "tool-result",
      parentId: "tool-request",
      timestamp,
      message: {
        role: "toolResult",
        toolCallId: "read-call",
        toolName: "read",
        content: [{ type: "text", text: "saved tool output" }],
        isError: false,
        timestamp: Date.now(),
      },
    },
    {
      type: "message",
      id: "a1",
      parentId: "tool-result",
      timestamp,
      message: assistant("old answer"),
    },
    {
      type: "message",
      id: "abandoned",
      parentId: "a1",
      timestamp,
      message: { role: "user", content: "abandoned question", timestamp: Date.now() },
    },
    {
      type: "compaction",
      id: "compact",
      parentId: "a1",
      timestamp,
      summary: "old summary",
      firstKeptEntryId: null,
      tokensBefore: 50000,
    },
    {
      type: "message",
      id: "u2",
      parentId: "compact",
      timestamp,
      message: { role: "user", content: "follow up", timestamp: Date.now() },
    },
    { type: "message", id: "a2", parentId: "u2", timestamp, message: assistant("new answer") },
  ];
  await writeFile(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  const logger = pino({ level: "silent" });
  const daemon = await createTestPaseoDaemon({
    agentClients: { pi: new PiRpcAgentClient({ logger }) },
    logger,
    paseoHomeRoot: path.join(root, "home"),
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    const imported = await client.importAgent({ provider: "pi", sessionId: file, cwd });
    const session = { agentId: imported.id, cwd };
    const expected = { userTexts: ["old question", "follow up"], assistantCount: 2 };
    expectTimeline(await fetchTimelineItems(client, imported.id), expected);
    expect(
      userMessageIdForToken(await fetchTimelineItems(client, imported.id), "old question"),
    ).toBe("u1");
    expect(userMessageIdForToken(await fetchTimelineItems(client, imported.id), "follow up")).toBe(
      "u2",
    );
    expect(await runtimeSessionId({ client, daemon }, session)).toBe(nativeId);
    await client.refreshAgent(imported.id);
    const restored = await fetchTimelineItems(client, imported.id);
    expectTimeline(restored, expected);
    const tools = restored.filter((item) => item.type === "tool_call");
    expect(tools).toHaveLength(1);
    expect(tools[0].detail).toEqual({
      type: "read",
      filePath: "readme.txt",
      content: "saved tool output",
    });
    expect(
      restored.filter((item) => item.type === "user_message").map((item) => item.messageId),
    ).toEqual(["u1", "u2"]);
    const oldAnswer = restored.find(
      (item) => item.type === "assistant_message" && item.text === "old answer",
    );
    if (oldAnswer?.type !== "assistant_message" || !oldAnswer.messageId)
      throw new Error("Restored reply missing identity");
    const beforeFork = await readFile(file, "utf8");
    const fork = await client.buildAgentForkContext(imported.id, {
      boundaryMessageId: oldAnswer.messageId,
    });
    expect(fork.attachment?.text).toContain("old question");
    expect(fork.attachment?.text).toContain("old answer");
    expect(fork.attachment?.text).not.toContain("follow up");
    expect(fork.attachment?.text).not.toContain("abandoned question");
    expect(await readFile(file, "utf8")).toBe(beforeFork);
    const forkFile = path.join(root, "native-fork.jsonl");
    const forkId = randomUUID();
    await writeFile(
      forkFile,
      [
        { ...records[0], id: forkId },
        ...records.slice(1),
        {
          type: "custom",
          id: "fork-leaf",
          parentId: "a1",
          timestamp,
          customType: "paseo_rewind",
          data: { targetId: "a1" },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n") + "\n",
    );
    const importedFork = await client.importAgent({ provider: "pi", sessionId: forkFile, cwd });
    expectTimeline(await fetchTimelineItems(client, importedFork.id), {
      userTexts: ["old question"],
      assistantCount: 1,
    });
    expect(await runtimeSessionId({ client, daemon }, { agentId: importedFork.id, cwd })).toBe(
      forkId,
    );
    expect(await readFile(file, "utf8")).toBe(beforeFork);
    await client.rewindAgent(imported.id, "u2", "conversation");
    expectTimeline(await fetchTimelineItems(client, imported.id), {
      userTexts: ["old question"],
      assistantCount: 1,
    });
    await client.refreshAgent(imported.id);
    expectTimeline(await fetchTimelineItems(client, imported.id), {
      userTexts: ["old question"],
      assistantCount: 1,
    });
    expect(await runtimeSessionId({ client, daemon }, session)).toBe(nativeId);
    await client.rewindAgent(imported.id, "u1", "conversation");
    await client.refreshAgent(imported.id);
    expectTimeline(await fetchTimelineItems(client, imported.id), {
      userTexts: [],
      assistantCount: 0,
    });
    expect(await runtimeSessionId({ client, daemon }, session)).toBe(nativeId);
  } finally {
    await client.close();
    await daemon.close();
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
