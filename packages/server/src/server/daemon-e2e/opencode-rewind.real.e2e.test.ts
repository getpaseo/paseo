import { execFileSync } from "node:child_process";
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { OpenCodeAgentClient } from "../agent/providers/opencode-agent.js";
import type { AgentTimelineItem } from "../agent/agent-sdk-types.js";
import type { AgentLifecycleStatus } from "@getpaseo/protocol/agent-lifecycle";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { getFullAccessConfig } from "./agent-configs.js";
import {
  closeRewindSession,
  fetchTimelineItems,
  fileExists,
  readScratchFile,
  tmpRewindCwd,
  userMessageIdForToken,
} from "./test-utils/rewind-helpers.js";

interface OpenCodeRewindHarness {
  client: DaemonClient;
  daemon: TestPaseoDaemon;
}

interface OpenCodeRewindSession {
  agentId: string;
  cwd: string;
  scratchPath: string;
}

interface AgentStatusRecord {
  at: number;
  status: AgentLifecycleStatus;
}

const TURN_TIMEOUT_MS = 180_000;

async function launchOpenCodeRewindSession(
  harness: OpenCodeRewindHarness,
  title: string,
): Promise<OpenCodeRewindSession> {
  const cwd = tmpRewindCwd("daemon-real-opencode-rewind-", { realpath: true });
  const scratchPath = path.join(cwd, "rewind-scratch.txt");
  execFileSync("git", ["init"], { cwd, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "paseo-test@example.com"], {
    cwd,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.name", "Paseo Test"], { cwd, stdio: "ignore" });
  await writeFile(scratchPath, "BASE\n", "utf8");
  execFileSync("git", ["add", "rewind-scratch.txt"], { cwd, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "base"], { cwd, stdio: "ignore" });

  const agent = await harness.client.createAgent({
    cwd,
    title,
    ...getFullAccessConfig("opencode"),
  });

  return { agentId: agent.id, cwd, scratchPath };
}

async function runtimeSessionId(
  harness: OpenCodeRewindHarness,
  session: OpenCodeRewindSession,
): Promise<string> {
  const snapshot = await harness.client.fetchAgent(session.agentId);
  const sessionId =
    snapshot?.agent.runtimeInfo?.sessionId ?? snapshot?.agent.persistence?.sessionId;
  if (!sessionId) {
    throw new Error(`Agent ${session.agentId} does not have a visible OpenCode session id`);
  }
  return sessionId;
}

function expectOpenCodeSessionId(value: string): void {
  expect(value).toMatch(/^ses_/);
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

function expectUserMessageCount(items: AgentTimelineItem[], expected: number): void {
  expect(roleItems(items, "user_message")).toHaveLength(expected);
}

async function recordAgentStatusTransitions(
  harness: OpenCodeRewindHarness,
  session: OpenCodeRewindSession,
): Promise<{ records: AgentStatusRecord[]; stop: () => void }> {
  const records: AgentStatusRecord[] = [];
  const initial = await harness.client.fetchAgent(session.agentId);
  if (initial?.agent.status) {
    records.push({ at: Date.now(), status: initial.agent.status });
  }
  const unsubscribe = harness.client.on("agent_update", (message) => {
    if (message.payload.kind !== "upsert" || message.payload.agent.id !== session.agentId) {
      return;
    }
    records.push({ at: Date.now(), status: message.payload.agent.status });
  });

  return { records, stop: unsubscribe };
}

function screenStatusForInvariant(status: AgentLifecycleStatus): "loading" | AgentLifecycleStatus {
  return status === "initializing" ? "loading" : status;
}

function expectNoLoadingRegression(records: AgentStatusRecord[]): void {
  const statuses = records.map((record) => screenStatusForInvariant(record.status));
  for (let index = 1; index < statuses.length; index += 1) {
    expect([statuses[index - 1], statuses[index]]).not.toEqual(["running", "loading"]);
  }
  for (let index = 2; index < statuses.length; index += 1) {
    expect([statuses[index - 2], statuses[index - 1], statuses[index]]).not.toEqual([
      "idle",
      "loading",
      "idle",
    ]);
  }
}

async function expectAgentIdle(
  harness: OpenCodeRewindHarness,
  session: OpenCodeRewindSession,
): Promise<void> {
  const snapshot = await harness.client.fetchAgent(session.agentId);
  expect(snapshot?.agent.status).toBe("idle");
}

async function createdFilesAtCwd(session: OpenCodeRewindSession): Promise<string[]> {
  const entries = await readdir(session.cwd);
  return entries
    .filter((name) =>
      ["rewind-scratch.txt", "opencode-multi-a.txt", "opencode-multi-b.txt"].includes(name),
    )
    .sort();
}

async function expectCreatedFiles(
  session: OpenCodeRewindSession,
  expectedNames: string[],
): Promise<void> {
  await expect(createdFilesAtCwd(session)).resolves.toEqual([...expectedNames].sort());
}

async function closeOpenCodeRewindSession(session: OpenCodeRewindSession): Promise<void> {
  closeRewindSession(session);
}

function editPrompt(input: {
  fileName: string;
  promptToken: string;
  content: string;
  doneToken: string;
}): string {
  return [
    `PASEO_OPENCODE_REWIND_PROMPT_${input.promptToken}.`,
    `Use the edit or write tool, not shell commands, to make ${input.fileName} contain exactly:`,
    "```",
    input.content.trimEnd(),
    "```",
    `When the file is saved, reply exactly: ${input.doneToken}`,
  ].join("\n");
}

async function askOpenCodeToEditFile(
  harness: OpenCodeRewindHarness,
  session: OpenCodeRewindSession,
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

async function rewindOpenCode(
  harness: OpenCodeRewindHarness,
  session: OpenCodeRewindSession,
  messageId: string,
): Promise<void> {
  await harness.client.rewindAgent(session.agentId, messageId, "both");
}

describe("daemon E2E (real opencode) - rewind", () => {
  let harness: OpenCodeRewindHarness;

  beforeAll(async () => {
    const logger = pino({ level: "silent" });
    const daemon = await createTestPaseoDaemon({
      agentClients: { opencode: new OpenCodeAgentClient(logger) },
      logger,
    });
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      appVersion: "0.1.70",
    });

    await client.connect();
    await client.fetchAgents({ subscribe: { subscriptionId: "opencode-rewind-real" } });
    harness = { client, daemon };
  }, 30_000);

  afterAll(async () => {
    await harness?.client.close().catch(() => undefined);
    await harness?.daemon.close().catch(() => undefined);
  });

  test("rewinds conversation and files after a single real OpenCode edit turn", async () => {
    const session = await launchOpenCodeRewindSession(harness, "opencode-rewind-single-edit-real");

    try {
      await askOpenCodeToEditFile(harness, session, {
        promptToken: "SINGLE",
        content: "BASE\nOPENCODE_SINGLE_MARKER\n",
        doneToken: "OPENCODE_SINGLE_DONE",
      });
      const timeline = await fetchTimelineItems(harness.client, session.agentId);
      expectUserMessageCount(timeline, 1);
      const messageId = userMessageIdForToken(timeline, "OPENCODE_REWIND_PROMPT_SINGLE");
      const sessionIdBefore = await runtimeSessionId(harness, session);
      expectOpenCodeSessionId(sessionIdBefore);
      const statusTransitions = await recordAgentStatusTransitions(harness, session);

      try {
        await rewindOpenCode(harness, session, messageId);
      } finally {
        statusTransitions.stop();
      }
      const sessionIdAfter = await runtimeSessionId(harness, session);
      const fileText = await readScratchFile(session);
      const rewoundTimeline = await fetchTimelineItems(harness.client, session.agentId);

      expect(sessionIdAfter).toBe(sessionIdBefore);
      await expectAgentIdle(harness, session);
      expectNoLoadingRegression(statusTransitions.records);
      expect(fileText).toBe("BASE\n");
      await expectCreatedFiles(session, ["rewind-scratch.txt"]);
      expectTimeline(rewoundTimeline, { userTexts: [], assistantCount: 0 });
    } finally {
      await closeOpenCodeRewindSession(session);
    }
  }, 420_000);

  test("records exactly one plain-text user message for a real OpenCode turn", async () => {
    const session = await launchOpenCodeRewindSession(
      harness,
      "opencode-plain-text-user-message-real",
    );
    const prompt = "PASEO_OPENCODE_PLAIN_TEXT_DUP_CHECK. Reply exactly: OPENCODE_PLAIN_TEXT_DONE";

    try {
      await harness.client.sendMessage(session.agentId, prompt);
      const finish = await harness.client.waitForFinish(session.agentId, TURN_TIMEOUT_MS);
      expect(finish.status).toBe("idle");
      expect(finish.final?.lastError).toBeUndefined();

      const timeline = await fetchTimelineItems(harness.client, session.agentId);
      const userMessages = roleItems(timeline, "user_message");
      expect(userMessages).toHaveLength(1);
      expect(userMessages[0]?.text).toBe(prompt);
    } finally {
      await closeOpenCodeRewindSession(session);
    }
  }, 420_000);

  test("rewinds a real OpenCode read-only turn without changing files", async () => {
    const session = await launchOpenCodeRewindSession(harness, "opencode-rewind-read-only-real");

    try {
      await harness.client.sendMessage(
        session.agentId,
        [
          "PASEO_OPENCODE_REWIND_PROMPT_READ_ONLY.",
          `Inspect ${path.basename(session.scratchPath)} without editing files.`,
          "Reply exactly: OPENCODE_READ_ONLY_DONE",
        ].join(" "),
      );
      const finish = await harness.client.waitForFinish(session.agentId, TURN_TIMEOUT_MS);
      expect(finish.status).toBe("idle");
      expect(finish.final?.lastError).toBeUndefined();

      const timeline = await fetchTimelineItems(harness.client, session.agentId);
      expectUserMessageCount(timeline, 1);
      const messageId = userMessageIdForToken(timeline, "OPENCODE_REWIND_PROMPT_READ_ONLY");
      const sessionIdBefore = await runtimeSessionId(harness, session);
      expectOpenCodeSessionId(sessionIdBefore);
      const statusTransitions = await recordAgentStatusTransitions(harness, session);

      try {
        await rewindOpenCode(harness, session, messageId);
      } finally {
        statusTransitions.stop();
      }
      const sessionIdAfter = await runtimeSessionId(harness, session);
      const fileText = await readScratchFile(session);
      const rewoundTimeline = await fetchTimelineItems(harness.client, session.agentId);

      expect(sessionIdAfter).toBe(sessionIdBefore);
      await expectAgentIdle(harness, session);
      expectNoLoadingRegression(statusTransitions.records);
      expect(fileText).toBe("BASE\n");
      await expectCreatedFiles(session, ["rewind-scratch.txt"]);
      expectTimeline(rewoundTimeline, { userTexts: [], assistantCount: 0 });
    } finally {
      await closeOpenCodeRewindSession(session);
    }
  }, 420_000);

  test("rewinds every file from a single real OpenCode multi-tool edit turn", async () => {
    const session = await launchOpenCodeRewindSession(harness, "opencode-rewind-multi-edit-real");
    const firstPath = path.join(session.cwd, "opencode-multi-a.txt");
    const secondPath = path.join(session.cwd, "opencode-multi-b.txt");

    try {
      await harness.client.sendMessage(
        session.agentId,
        [
          "PASEO_OPENCODE_REWIND_PROMPT_MULTI_EDIT.",
          "Create opencode-multi-a.txt with exactly OPENCODE_MULTI_A.",
          "Create opencode-multi-b.txt with exactly OPENCODE_MULTI_B.",
          "Do not use shell commands.",
          "Reply exactly: OPENCODE_MULTI_EDIT_DONE",
        ].join("\n"),
      );
      const finish = await harness.client.waitForFinish(session.agentId, TURN_TIMEOUT_MS);
      expect(finish.status).toBe("idle");
      expect(finish.final?.lastError).toBeUndefined();
      await expect(fileExists(firstPath)).resolves.toBe(true);
      await expect(fileExists(secondPath)).resolves.toBe(true);

      const timeline = await fetchTimelineItems(harness.client, session.agentId);
      expectUserMessageCount(timeline, 1);
      const messageId = userMessageIdForToken(timeline, "OPENCODE_REWIND_PROMPT_MULTI_EDIT");
      const sessionIdBefore = await runtimeSessionId(harness, session);
      expectOpenCodeSessionId(sessionIdBefore);
      const statusTransitions = await recordAgentStatusTransitions(harness, session);

      try {
        await rewindOpenCode(harness, session, messageId);
      } finally {
        statusTransitions.stop();
      }
      const sessionIdAfter = await runtimeSessionId(harness, session);
      const rewoundTimeline = await fetchTimelineItems(harness.client, session.agentId);

      expect(sessionIdAfter).toBe(sessionIdBefore);
      await expectAgentIdle(harness, session);
      expectNoLoadingRegression(statusTransitions.records);
      await expect(fileExists(firstPath)).resolves.toBe(false);
      await expect(fileExists(secondPath)).resolves.toBe(false);
      await expectCreatedFiles(session, ["rewind-scratch.txt"]);
      expectTimeline(rewoundTimeline, { userTexts: [], assistantCount: 0 });
    } finally {
      await closeOpenCodeRewindSession(session);
    }
  }, 420_000);

  test("rewinds conversation and files together against a real OpenCode session", async () => {
    const session = await launchOpenCodeRewindSession(harness, "opencode-rewind-both-real");

    try {
      await askOpenCodeToEditFile(harness, session, {
        promptToken: "BOTH_FIRST",
        content: "BASE\nOPENCODE_BOTH_FIRST_MARKER\n",
        doneToken: "OPENCODE_BOTH_FIRST_DONE",
      });
      const fileTextAfterFirstTurn = await readScratchFile(session);
      const firstTimeline = await fetchTimelineItems(harness.client, session.agentId);
      expectUserMessageCount(firstTimeline, 1);

      await askOpenCodeToEditFile(harness, session, {
        promptToken: "BOTH_SECOND",
        content: "BASE\nOPENCODE_BOTH_FIRST_MARKER\nOPENCODE_BOTH_SECOND_MARKER\n",
        doneToken: "OPENCODE_BOTH_SECOND_DONE",
      });
      const secondTimeline = await fetchTimelineItems(harness.client, session.agentId);
      expectUserMessageCount(secondTimeline, 2);
      const secondMessageId = userMessageIdForToken(secondTimeline, "BOTH_SECOND");
      const sessionIdBefore = await runtimeSessionId(harness, session);
      expectOpenCodeSessionId(sessionIdBefore);
      const statusTransitions = await recordAgentStatusTransitions(harness, session);

      try {
        await rewindOpenCode(harness, session, secondMessageId);
      } finally {
        statusTransitions.stop();
      }
      const sessionIdAfter = await runtimeSessionId(harness, session);
      const fileText = await readScratchFile(session);
      const rewoundTimeline = await fetchTimelineItems(harness.client, session.agentId);

      expect(sessionIdAfter).toBe(sessionIdBefore);
      await expectAgentIdle(harness, session);
      expectNoLoadingRegression(statusTransitions.records);
      expect(fileText).toBe(fileTextAfterFirstTurn);
      await expectCreatedFiles(session, ["rewind-scratch.txt"]);
      expectTimeline(rewoundTimeline, {
        userTexts: [
          editPrompt({
            fileName: path.basename(session.scratchPath),
            promptToken: "BOTH_FIRST",
            content: "BASE\nOPENCODE_BOTH_FIRST_MARKER\n",
            doneToken: "OPENCODE_BOTH_FIRST_DONE",
          }),
        ],
        assistantCount: 1,
      });
    } finally {
      await closeOpenCodeRewindSession(session);
    }
  }, 420_000);
});
