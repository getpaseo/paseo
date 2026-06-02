import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import type { AgentTimelineItem } from "../agent/agent-sdk-types.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import {
  canRunRealProvider,
  createRealProviderClients,
  getRealProviderConfig,
} from "./real-provider-test-config.js";
import {
  closeRewindSession,
  fetchTimelineItems,
  fileExists,
  readScratchFile,
  tmpRewindCwd,
  userMessageIdForToken,
} from "./test-utils/rewind-helpers.js";

interface CodexRewindHarness {
  client: DaemonClient;
  daemon: TestPaseoDaemon;
}

interface CodexRewindSession {
  agentId: string;
  cwd: string;
  scratchPath: string;
}

const TURN_TIMEOUT_MS = 180_000;

async function fetchThreadId(client: DaemonClient, agentId: string): Promise<string> {
  const result = await client.fetchAgent(agentId);
  const threadId = result?.agent.persistence?.sessionId ?? result?.agent.runtimeInfo?.sessionId;
  if (!threadId) {
    throw new Error(`Agent ${agentId} does not have a visible Codex thread id`);
  }
  return threadId;
}

function expectThreadId(value: string): void {
  expect(value).toMatch(/^[a-f0-9-]{36}$/);
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

async function createdFilesAtCwd(session: CodexRewindSession): Promise<string[]> {
  const entries = await readdir(session.cwd);
  return entries
    .filter((name) => name === "rewind-scratch.txt" || name === "codex-dummy.txt")
    .sort();
}

async function expectCreatedFiles(
  session: CodexRewindSession,
  expectedNames: string[],
): Promise<void> {
  await expect(createdFilesAtCwd(session)).resolves.toEqual([...expectedNames].sort());
}

async function launchCodexRewindSession(
  harness: CodexRewindHarness,
  title: string,
): Promise<CodexRewindSession> {
  const cwd = tmpRewindCwd("daemon-real-codex-rewind-");
  const scratchPath = path.join(cwd, "rewind-scratch.txt");
  await writeFile(scratchPath, "BASE\n", "utf8");

  const agent = await harness.client.createAgent({
    cwd,
    title,
    ...getRealProviderConfig("codex"),
  });

  return { agentId: agent.id, cwd, scratchPath };
}

async function closeCodexRewindSession(session: CodexRewindSession): Promise<void> {
  closeRewindSession(session);
}

function editPrompt(input: {
  fileName: string;
  promptToken: string;
  content: string;
  doneToken: string;
}): string {
  return [
    `PASEO_CODEX_REWIND_PROMPT_${input.promptToken}.`,
    `Use apply_patch to make ${input.fileName} contain exactly:`,
    "```",
    input.content.trimEnd(),
    "```",
    `When the file is saved, reply exactly: ${input.doneToken}`,
  ].join("\n");
}

function singleCreatePrompt(): string {
  return [
    "PASEO_CODEX_REWIND_PROMPT_SINGLE_CREATE.",
    "Use apply_patch to create codex-dummy.txt with exactly CODEX_CREATED.",
    "When the file is saved, reply exactly: CODEX_SINGLE_CREATE_DONE",
  ].join("\n");
}

async function askCodexToEditFile(
  harness: CodexRewindHarness,
  session: CodexRewindSession,
  input: {
    promptToken: string;
    content: string;
    doneToken: string;
  },
): Promise<void> {
  await harness.client.sendMessage(
    session.agentId,
    editPrompt({
      fileName: path.basename(session.scratchPath),
      promptToken: input.promptToken,
      content: input.content,
      doneToken: input.doneToken,
    }),
  );
  const finish = await harness.client.waitForFinish(session.agentId, TURN_TIMEOUT_MS);
  expect(finish.status).toBe("idle");
  expect(finish.final?.lastError).toBeUndefined();
}

describe("daemon E2E (real codex) - rewind", () => {
  let canRun = false;
  let harness: CodexRewindHarness;

  beforeAll(async () => {
    canRun = await canRunRealProvider("codex");
    if (!canRun) {
      return;
    }
    const logger = pino({ level: "silent" });
    const daemon = await createTestPaseoDaemon({
      agentClients: createRealProviderClients(["codex"], logger),
      logger,
    });
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      appVersion: "0.1.70",
    });

    await client.connect();
    await client.fetchAgents({ subscribe: { subscriptionId: "codex-rewind-real" } });
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

  test("rewinds a real Codex conversation after a single edit turn while leaving the file edit on disk", async () => {
    if (!harness) throw new Error("Codex rewind harness was not initialized");
    const session = await launchCodexRewindSession(harness, "codex-rewind-single-edit-real");

    try {
      await askCodexToEditFile(harness, session, {
        promptToken: "SINGLE",
        content: "BASE\nCODEX_SINGLE_MARKER\n",
        doneToken: "CODEX_SINGLE_DONE",
      });
      const timeline = await fetchTimelineItems(harness.client, session.agentId);
      const messageId = userMessageIdForToken(timeline, "CODEX_REWIND_PROMPT_SINGLE");

      await harness.client.rewindAgent(session.agentId, messageId, "conversation");
      const rewoundTimeline = await fetchTimelineItems(harness.client, session.agentId);
      const fileText = await readScratchFile(session);

      expectTimeline(rewoundTimeline, { userTexts: [], assistantCount: 0 });
      await expectCreatedFiles(session, ["rewind-scratch.txt"]);
      expect(fileText).toBe("BASE\nCODEX_SINGLE_MARKER\n");
    } finally {
      await closeCodexRewindSession(session);
    }
  }, 420_000);

  test("rewinds a real Codex conversation after a single file-creation turn while leaving the created file on disk", async () => {
    const session = await launchCodexRewindSession(harness, "codex-rewind-single-create-real");
    const dummyPath = path.join(session.cwd, "codex-dummy.txt");

    try {
      await harness.client.sendMessage(session.agentId, singleCreatePrompt());
      const finish = await harness.client.waitForFinish(session.agentId, TURN_TIMEOUT_MS);
      expect(finish.status).toBe("idle");
      expect(finish.final?.lastError).toBeUndefined();
      await expect(fileExists(dummyPath)).resolves.toBe(true);

      const timeline = await fetchTimelineItems(harness.client, session.agentId);
      const messageId = userMessageIdForToken(timeline, "CODEX_REWIND_PROMPT_SINGLE_CREATE");

      await harness.client.rewindAgent(session.agentId, messageId, "conversation");
      const rewoundTimeline = await fetchTimelineItems(harness.client, session.agentId);

      await expect(fileExists(dummyPath)).resolves.toBe(true);
      await expectCreatedFiles(session, ["codex-dummy.txt", "rewind-scratch.txt"]);
      expectTimeline(rewoundTimeline, { userTexts: [], assistantCount: 0 });
    } finally {
      await closeCodexRewindSession(session);
    }
  }, 420_000);

  test("rewinds a real Codex conversation to a forked thread while leaving file edits on disk", async () => {
    const session = await launchCodexRewindSession(harness, "codex-rewind-conversation-real");

    try {
      await askCodexToEditFile(harness, session, {
        promptToken: "FIRST",
        content: "BASE\nCODEX_FIRST_MARKER\n",
        doneToken: "CODEX_FIRST_DONE",
      });
      const firstTimeline = await fetchTimelineItems(harness.client, session.agentId);
      const firstMessageId = userMessageIdForToken(firstTimeline, "CODEX_REWIND_PROMPT_FIRST");

      await askCodexToEditFile(harness, session, {
        promptToken: "SECOND",
        content: "BASE\nCODEX_FIRST_MARKER\nCODEX_SECOND_MARKER\n",
        doneToken: "CODEX_SECOND_DONE",
      });
      const oldThreadId = await fetchThreadId(harness.client, session.agentId);
      expectThreadId(oldThreadId);

      await harness.client.rewindAgent(session.agentId, firstMessageId, "conversation");
      const newThreadId = await fetchThreadId(harness.client, session.agentId);
      const rewoundTimeline = await fetchTimelineItems(harness.client, session.agentId);
      const fileText = await readScratchFile(session);

      expect(newThreadId).not.toBe(oldThreadId);
      expectThreadId(newThreadId);
      expectTimeline(rewoundTimeline, { userTexts: [], assistantCount: 0 });
      await expectCreatedFiles(session, ["rewind-scratch.txt"]);
      expect(fileText).toBe("BASE\nCODEX_FIRST_MARKER\nCODEX_SECOND_MARKER\n");
    } finally {
      await closeCodexRewindSession(session);
    }
  }, 420_000);
});
