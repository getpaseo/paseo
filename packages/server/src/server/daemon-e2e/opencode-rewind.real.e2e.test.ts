import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { OpenCodeAgentClient } from "../agent/providers/opencode-agent.js";
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

interface OpenCodeRewindHarness {
  client: DaemonClient;
  daemon: TestPaseoDaemon;
}

interface OpenCodeRewindSession {
  agentId: string;
  cwd: string;
  scratchPath: string;
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
      const messageId = userMessageIdForToken(timeline, "OPENCODE_REWIND_PROMPT_SINGLE");

      await rewindOpenCode(harness, session, messageId);
      const fileText = await readScratchFile(session);
      const rewoundTimeline = await fetchTimelineItems(harness.client, session.agentId);

      expect(fileText).toBe("BASE\n");
      expect(textByRole(rewoundTimeline, "user_message")).not.toContain(
        "OPENCODE_REWIND_PROMPT_SINGLE",
      );
      expect(textByRole(rewoundTimeline, "assistant_message")).not.toContain(
        "OPENCODE_SINGLE_DONE",
      );
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
      const messageId = userMessageIdForToken(timeline, "OPENCODE_REWIND_PROMPT_READ_ONLY");

      await rewindOpenCode(harness, session, messageId);
      const fileText = await readScratchFile(session);
      const rewoundTimeline = await fetchTimelineItems(harness.client, session.agentId);

      expect(fileText).toBe("BASE\n");
      expect(textByRole(rewoundTimeline, "user_message")).not.toContain(
        "OPENCODE_REWIND_PROMPT_READ_ONLY",
      );
      expect(textByRole(rewoundTimeline, "assistant_message")).not.toContain(
        "OPENCODE_READ_ONLY_DONE",
      );
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
      const messageId = userMessageIdForToken(timeline, "OPENCODE_REWIND_PROMPT_MULTI_EDIT");

      await rewindOpenCode(harness, session, messageId);
      const rewoundTimeline = await fetchTimelineItems(harness.client, session.agentId);

      await expect(fileExists(firstPath)).resolves.toBe(false);
      await expect(fileExists(secondPath)).resolves.toBe(false);
      expect(textByRole(rewoundTimeline, "assistant_message")).not.toContain(
        "OPENCODE_MULTI_EDIT_DONE",
      );
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

      await askOpenCodeToEditFile(harness, session, {
        promptToken: "BOTH_SECOND",
        content: "BASE\nOPENCODE_BOTH_FIRST_MARKER\nOPENCODE_BOTH_SECOND_MARKER\n",
        doneToken: "OPENCODE_BOTH_SECOND_DONE",
      });
      const secondTimeline = await fetchTimelineItems(harness.client, session.agentId);
      const secondMessageId = userMessageIdForToken(secondTimeline, "BOTH_SECOND");

      await rewindOpenCode(harness, session, secondMessageId);
      const fileText = await readScratchFile(session);
      const rewoundTimeline = await fetchTimelineItems(harness.client, session.agentId);

      expect(fileText).toBe(fileTextAfterFirstTurn);
      expect(fileText).not.toContain("OPENCODE_BOTH_SECOND_MARKER");
      expect(textByRole(rewoundTimeline, "user_message")).toContain("BOTH_FIRST");
      expect(textByRole(rewoundTimeline, "user_message")).not.toContain("BOTH_SECOND");
      expect(textByRole(rewoundTimeline, "assistant_message")).not.toContain(
        "OPENCODE_BOTH_SECOND_DONE",
      );
    } finally {
      await closeOpenCodeRewindSession(session);
    }
  }, 420_000);
});
