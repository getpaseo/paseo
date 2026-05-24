import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { ClaudeAgentClient } from "../agent/providers/claude/agent.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { getFullAccessConfig } from "./agent-configs.js";
import {
  closeRewindSession,
  fetchTimelineItems,
  fileExists,
  readScratchFile,
  textByRole,
  tmpRewindCwd,
  userMessageIdForToken,
} from "./test-utils/rewind-helpers.js";

interface ClaudeRewindHarness {
  client: DaemonClient;
  daemon: TestPaseoDaemon;
}

interface ClaudeRewindSession {
  agentId: string;
  cwd: string;
  scratchPath: string;
}

const TURN_TIMEOUT_MS = 180_000;

function compactText(value: string): string {
  return value.replace(/\s+/g, "").toLowerCase();
}

async function launchClaudeRewindSession(
  harness: ClaudeRewindHarness,
  title: string,
): Promise<ClaudeRewindSession> {
  const cwd = tmpRewindCwd("daemon-real-claude-rewind-");
  const scratchPath = path.join(cwd, "rewind-scratch.txt");
  await writeFile(scratchPath, "BASE\n", "utf8");

  const agent = await harness.client.createAgent({
    cwd,
    title,
    ...getFullAccessConfig("claude"),
  });

  return { agentId: agent.id, cwd, scratchPath };
}

async function closeClaudeRewindSession(session: ClaudeRewindSession): Promise<void> {
  closeRewindSession(session);
}

function editPrompt(input: {
  fileName: string;
  promptToken: string;
  content: string;
  doneToken: string;
}): string {
  return [
    `PASEO_REWIND_PROMPT_${input.promptToken}.`,
    `Use the Edit or Write tool, not Bash, to make ${input.fileName} contain exactly:`,
    "```",
    input.content.trimEnd(),
    "```",
    `When the file is saved, reply exactly: ${input.doneToken}`,
  ].join("\n");
}

async function askClaudeToEditFile(
  harness: ClaudeRewindHarness,
  session: ClaudeRewindSession,
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

async function askClaudeWhatTheCurrentConversationRemembers(
  harness: ClaudeRewindHarness,
  session: ClaudeRewindSession,
): Promise<void> {
  await harness.client.sendMessage(
    session.agentId,
    [
      "Do not inspect files.",
      "Based only on this conversation, what exact marker did I most recently ask you to add?",
      "Reply with one marker only.",
    ].join(" "),
  );
  const finish = await harness.client.waitForFinish(session.agentId, TURN_TIMEOUT_MS);
  expect(finish.status).toBe("idle");
  expect(finish.final?.lastError).toBeUndefined();
}

async function rewindClaude(
  harness: ClaudeRewindHarness,
  session: ClaudeRewindSession,
  messageId: string,
  mode: "conversation" | "files" | "both",
): Promise<void> {
  await harness.client.rewindAgent(session.agentId, messageId, mode);
}

describe("daemon E2E (real claude) - rewind", () => {
  let harness: ClaudeRewindHarness;

  beforeAll(async () => {
    const logger = pino({ level: "silent" });
    const daemon = await createTestPaseoDaemon({
      agentClients: { claude: new ClaudeAgentClient({ logger }) },
      logger,
    });
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      appVersion: "0.1.70",
    });

    await client.connect();
    await client.fetchAgents({ subscribe: { subscriptionId: "claude-rewind-real" } });
    harness = { client, daemon };
  }, 30_000);

  afterAll(async () => {
    await harness?.client.close().catch(() => undefined);
    await harness?.daemon.close().catch(() => undefined);
  });

  test("rewinds files after a single real Claude Write tool turn that creates a file", async () => {
    const session = await launchClaudeRewindSession(harness, "claude-rewind-single-write-files");
    const dummyPath = path.join(session.cwd, "dummy.txt");

    try {
      await harness.client.sendMessage(
        session.agentId,
        [
          "PASEO_REWIND_PROMPT_SINGLE_WRITE_FILES.",
          "Use the Write tool, not Bash, to create dummy.txt with exactly:",
          "```",
          "hello world",
          "```",
          "When the file is saved, reply exactly: SINGLE_WRITE_FILES_DONE",
        ].join("\n"),
      );
      const finish = await harness.client.waitForFinish(session.agentId, TURN_TIMEOUT_MS);
      expect(finish.status).toBe("idle");
      expect(finish.final?.lastError).toBeUndefined();
      await expect(fileExists(dummyPath)).resolves.toBe(true);

      const timeline = await fetchTimelineItems(harness.client, session.agentId);
      const messageId = userMessageIdForToken(timeline, "SINGLE_WRITE_FILES");

      await rewindClaude(harness, session, messageId, "files");
      const rewoundTimeline = await fetchTimelineItems(harness.client, session.agentId);

      await expect(fileExists(dummyPath)).resolves.toBe(false);
      expect(textByRole(rewoundTimeline, "user_message")).toContain("SINGLE_WRITE_FILES");
    } finally {
      await closeClaudeRewindSession(session);
    }
  }, 420_000);

  test("rewinds conversation after a single real Claude no-edit turn without file checkpoints", async () => {
    const session = await launchClaudeRewindSession(
      harness,
      "claude-rewind-single-no-edit-conversation",
    );

    try {
      await harness.client.sendMessage(
        session.agentId,
        [
          "PASEO_REWIND_PROMPT_SINGLE_NO_EDIT.",
          "Do not inspect or modify files.",
          "Reply exactly: SINGLE_NO_EDIT_DONE",
        ].join(" "),
      );
      const finish = await harness.client.waitForFinish(session.agentId, TURN_TIMEOUT_MS);
      expect(finish.status).toBe("idle");
      expect(finish.final?.lastError).toBeUndefined();

      const timeline = await fetchTimelineItems(harness.client, session.agentId);
      const messageId = userMessageIdForToken(timeline, "SINGLE_NO_EDIT");

      await rewindClaude(harness, session, messageId, "conversation");
      const rewoundTimeline = await fetchTimelineItems(harness.client, session.agentId);

      expect(textByRole(rewoundTimeline, "user_message")).toContain("SINGLE_NO_EDIT");
      expect(textByRole(rewoundTimeline, "assistant_message")).not.toContain("SINGLE_NO_EDIT_DONE");
    } finally {
      await closeClaudeRewindSession(session);
    }
  }, 420_000);

  test("rewinds all files from a single real Claude turn with multiple Write tool calls", async () => {
    const session = await launchClaudeRewindSession(
      harness,
      "claude-rewind-single-multi-write-files",
    );
    const firstPath = path.join(session.cwd, "multi-a.txt");
    const secondPath = path.join(session.cwd, "multi-b.txt");

    try {
      await harness.client.sendMessage(
        session.agentId,
        [
          "PASEO_REWIND_PROMPT_SINGLE_MULTI_WRITE.",
          "Use the Write tool twice, not Bash.",
          "Create multi-a.txt with exactly this literal text: MULTI_A.",
          "Create multi-b.txt with exactly this literal text: MULTI_B.",
          "When both files are saved, reply exactly: SINGLE_MULTI_WRITE_DONE",
        ].join("\n"),
      );
      const finish = await harness.client.waitForFinish(session.agentId, TURN_TIMEOUT_MS);
      expect(finish.status).toBe("idle");
      expect(finish.final?.lastError).toBeUndefined();
      await expect(fileExists(firstPath)).resolves.toBe(true);
      await expect(fileExists(secondPath)).resolves.toBe(true);

      const timeline = await fetchTimelineItems(harness.client, session.agentId);
      const messageId = userMessageIdForToken(timeline, "SINGLE_MULTI_WRITE");

      await rewindClaude(harness, session, messageId, "files");

      await expect(fileExists(firstPath)).resolves.toBe(false);
      await expect(fileExists(secondPath)).resolves.toBe(false);
    } finally {
      await closeClaudeRewindSession(session);
    }
  }, 420_000);

  test("rewinds Claude Write edits from a turn that also changes a file through Bash", async () => {
    const session = await launchClaudeRewindSession(harness, "claude-rewind-write-and-bash-files");
    const writePath = path.join(session.cwd, "write-tool.txt");
    const bashPath = path.join(session.cwd, "bash-tool.txt");
    await writeFile(bashPath, "BASH_BASE\n", "utf8");

    try {
      await harness.client.sendMessage(
        session.agentId,
        [
          "PASEO_REWIND_PROMPT_WRITE_AND_BASH.",
          "Use the Write tool to create write-tool.txt with exactly this literal text: WRITE_TOOL.",
          "Then use Bash to append this literal text to bash-tool.txt: BASH_TOOL.",
          "When both changes are done, reply exactly: WRITE_AND_BASH_DONE",
        ].join("\n"),
      );
      const finish = await harness.client.waitForFinish(session.agentId, TURN_TIMEOUT_MS);
      expect(finish.status).toBe("idle");
      expect(finish.final?.lastError).toBeUndefined();
      await expect(fileExists(writePath)).resolves.toBe(true);
      await expect(readFile(bashPath, "utf8")).resolves.toContain("BASH_TOOL");

      const timeline = await fetchTimelineItems(harness.client, session.agentId);
      const messageId = userMessageIdForToken(timeline, "WRITE_AND_BASH");

      await rewindClaude(harness, session, messageId, "files");

      await expect(fileExists(writePath)).resolves.toBe(false);
      // Claude file rewind only has checkpoints for Claude file tools; Bash side effects remain.
      await expect(readFile(bashPath, "utf8")).resolves.toBe("BASH_BASE\nBASH_TOOL\n");
    } finally {
      await closeClaudeRewindSession(session);
    }
  }, 420_000);

  test("rewinds files after a real Claude read-only turn without file checkpoints", async () => {
    const session = await launchClaudeRewindSession(harness, "claude-rewind-read-only-files");

    try {
      await harness.client.sendMessage(
        session.agentId,
        [
          "PASEO_REWIND_PROMPT_READ_ONLY_FILES.",
          `Use the Read tool to inspect ${path.basename(session.scratchPath)}.`,
          "Do not modify files.",
          "Reply exactly: READ_ONLY_FILES_DONE",
        ].join("\n"),
      );
      const finish = await harness.client.waitForFinish(session.agentId, TURN_TIMEOUT_MS);
      expect(finish.status).toBe("idle");
      expect(finish.final?.lastError).toBeUndefined();

      const timeline = await fetchTimelineItems(harness.client, session.agentId);
      const messageId = userMessageIdForToken(timeline, "READ_ONLY_FILES");

      await rewindClaude(harness, session, messageId, "files");
      const fileText = await readScratchFile(session);
      const rewoundTimeline = await fetchTimelineItems(harness.client, session.agentId);

      expect(fileText).toBe("BASE\n");
      expect(textByRole(rewoundTimeline, "user_message")).toContain("READ_ONLY_FILES");
    } finally {
      await closeClaudeRewindSession(session);
    }
  }, 420_000);

  test("rewinds the conversation against a real Claude session and the second turn disappears from the rehydrated timeline", async () => {
    const session = await launchClaudeRewindSession(harness, "claude-rewind-conversation-real");

    try {
      await askClaudeToEditFile(harness, session, {
        promptToken: "CONVERSATION_FIRST",
        content: "BASE\nCONVERSATION_FIRST_MARKER\n",
        doneToken: "CONVERSATION_FIRST_DONE",
      });
      const firstTimeline = await fetchTimelineItems(harness.client, session.agentId);
      const firstMessageId = userMessageIdForToken(firstTimeline, "CONVERSATION_FIRST");

      await askClaudeToEditFile(harness, session, {
        promptToken: "CONVERSATION_SECOND",
        content: "BASE\nCONVERSATION_FIRST_MARKER\nCONVERSATION_SECOND_MARKER\n",
        doneToken: "CONVERSATION_SECOND_DONE",
      });
      await rewindClaude(harness, session, firstMessageId, "conversation");
      const rewoundTimeline = await fetchTimelineItems(harness.client, session.agentId);

      expect(textByRole(rewoundTimeline, "user_message")).toContain("CONVERSATION_FIRST");
      expect(textByRole(rewoundTimeline, "user_message")).not.toContain("CONVERSATION_SECOND");
      expect(textByRole(rewoundTimeline, "assistant_message")).not.toContain(
        "CONVERSATION_SECOND_DONE",
      );

      await askClaudeWhatTheCurrentConversationRemembers(harness, session);
      const continuedTimeline = await fetchTimelineItems(harness.client, session.agentId);
      const assistantText = compactText(textByRole(continuedTimeline, "assistant_message"));

      expect(assistantText).toContain("conversation_first_marker");
      expect(assistantText).not.toContain("conversation_second_marker");
    } finally {
      await closeClaudeRewindSession(session);
    }
  }, 420_000);

  test("rewinds files against a real Claude session while keeping the conversation timeline intact", async () => {
    const session = await launchClaudeRewindSession(harness, "claude-rewind-files-real");

    try {
      await askClaudeToEditFile(harness, session, {
        promptToken: "FILES_FIRST",
        content: "BASE\nFILES_FIRST_MARKER\n",
        doneToken: "FILES_FIRST_DONE",
      });
      await askClaudeToEditFile(harness, session, {
        promptToken: "FILES_SECOND",
        content: "BASE\nFILES_FIRST_MARKER\nFILES_SECOND_MARKER\n",
        doneToken: "FILES_SECOND_DONE",
      });
      const secondTimeline = await fetchTimelineItems(harness.client, session.agentId);
      const secondMessageId = userMessageIdForToken(secondTimeline, "FILES_SECOND");

      await rewindClaude(harness, session, secondMessageId, "files");
      const fileText = await readScratchFile(session);
      const rewoundTimeline = await fetchTimelineItems(harness.client, session.agentId);

      expect(fileText).toBe("BASE\nFILES_FIRST_MARKER\n");
      expect(textByRole(rewoundTimeline, "user_message")).toContain("FILES_SECOND");
      expect(textByRole(rewoundTimeline, "assistant_message")).toContain("FILES_SECOND_DONE");
    } finally {
      await closeClaudeRewindSession(session);
    }
  }, 420_000);

  test("rewinds conversation and files together against a real Claude session", async () => {
    const session = await launchClaudeRewindSession(harness, "claude-rewind-both-real");

    try {
      await askClaudeToEditFile(harness, session, {
        promptToken: "BOTH_FIRST",
        content: "BASE\nBOTH_FIRST_MARKER\n",
        doneToken: "BOTH_FIRST_DONE",
      });
      const firstTimeline = await fetchTimelineItems(harness.client, session.agentId);
      const firstMessageId = userMessageIdForToken(firstTimeline, "BOTH_FIRST");

      await askClaudeToEditFile(harness, session, {
        promptToken: "BOTH_SECOND",
        content: "BASE\nBOTH_FIRST_MARKER\nBOTH_SECOND_MARKER\n",
        doneToken: "BOTH_SECOND_DONE",
      });
      await rewindClaude(harness, session, firstMessageId, "both");
      const fileText = await readScratchFile(session);
      const rewoundTimeline = await fetchTimelineItems(harness.client, session.agentId);

      expect(fileText).toBe("BASE\nBOTH_FIRST_MARKER\n");
      expect(textByRole(rewoundTimeline, "user_message")).toContain("BOTH_FIRST");
      expect(textByRole(rewoundTimeline, "user_message")).not.toContain("BOTH_SECOND");
      expect(textByRole(rewoundTimeline, "assistant_message")).not.toContain("BOTH_SECOND_DONE");
    } finally {
      await closeClaudeRewindSession(session);
    }
  }, 420_000);
});
