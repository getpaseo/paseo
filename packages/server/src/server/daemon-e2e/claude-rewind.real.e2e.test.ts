import { writeFile } from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { ClaudeAgentClient } from "../agent/providers/claude/agent.js";
import type { AgentTimelineItem } from "../agent/agent-sdk-types.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { getFullAccessConfig } from "./agent-configs.js";
import {
  closeRewindSession,
  fetchTimelineItems,
  fileExists,
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
}

interface ClaudeTurnSpec {
  index: 1 | 2 | 3;
  promptToken: string;
  doneToken: string;
  fileName: string;
  content: string;
}

interface RewindCase {
  name: string;
  turnCount: 1 | 2 | 3;
  rewindTurn: 1 | 2 | 3;
  mode: "both" | "conversation" | "files";
}

const TURN_TIMEOUT_MS = 180_000;

const MATRIX: RewindCase[] = [
  {
    name: "single-turn session, rewind only user message, both",
    turnCount: 1,
    rewindTurn: 1,
    mode: "both",
  },
  { name: "two-turn session, rewind user #1, both", turnCount: 2, rewindTurn: 1, mode: "both" },
  { name: "two-turn session, rewind user #2, both", turnCount: 2, rewindTurn: 2, mode: "both" },
  { name: "three-turn session, rewind user #1, both", turnCount: 3, rewindTurn: 1, mode: "both" },
  { name: "three-turn session, rewind user #2, both", turnCount: 3, rewindTurn: 2, mode: "both" },
  { name: "three-turn session, rewind user #3, both", turnCount: 3, rewindTurn: 3, mode: "both" },
  {
    name: "single-turn session, rewind only user message, conversation",
    turnCount: 1,
    rewindTurn: 1,
    mode: "conversation",
  },
  {
    name: "two-turn session, rewind user #1, conversation",
    turnCount: 2,
    rewindTurn: 1,
    mode: "conversation",
  },
  {
    name: "two-turn session, rewind user #2, conversation",
    turnCount: 2,
    rewindTurn: 2,
    mode: "conversation",
  },
  {
    name: "three-turn session, rewind user #1, conversation",
    turnCount: 3,
    rewindTurn: 1,
    mode: "conversation",
  },
  {
    name: "three-turn session, rewind user #2, conversation",
    turnCount: 3,
    rewindTurn: 2,
    mode: "conversation",
  },
  {
    name: "three-turn session, rewind user #3, conversation",
    turnCount: 3,
    rewindTurn: 3,
    mode: "conversation",
  },
  {
    name: "single-turn session, rewind only user message, files",
    turnCount: 1,
    rewindTurn: 1,
    mode: "files",
  },
  { name: "two-turn session, rewind user #1, files", turnCount: 2, rewindTurn: 1, mode: "files" },
  { name: "two-turn session, rewind user #2, files", turnCount: 2, rewindTurn: 2, mode: "files" },
  { name: "three-turn session, rewind user #1, files", turnCount: 3, rewindTurn: 1, mode: "files" },
  { name: "three-turn session, rewind user #2, files", turnCount: 3, rewindTurn: 2, mode: "files" },
  { name: "three-turn session, rewind user #3, files", turnCount: 3, rewindTurn: 3, mode: "files" },
];

async function launchClaudeRewindSession(
  harness: ClaudeRewindHarness,
  title: string,
): Promise<ClaudeRewindSession> {
  const cwd = tmpRewindCwd("daemon-real-claude-rewind-");
  await writeFile(path.join(cwd, "baseline.txt"), "BASE\n", "utf8");

  const agent = await harness.client.createAgent({
    cwd,
    title,
    ...getFullAccessConfig("claude"),
  });

  return { agentId: agent.id, cwd };
}

async function closeClaudeRewindSession(session: ClaudeRewindSession): Promise<void> {
  closeRewindSession(session);
}

function buildTurns(scenario: RewindCase): ClaudeTurnSpec[] {
  const prefix = `${scenario.mode.toUpperCase()}_${scenario.turnCount}_${scenario.rewindTurn}`;
  return Array.from({ length: scenario.turnCount }, (_, offset) => {
    const index = (offset + 1) as 1 | 2 | 3;
    return {
      index,
      promptToken: `PASEO_RW_${prefix}_T${index}`,
      doneToken: `PASEO_RW_${prefix}_T${index}_DONE`,
      fileName: `turn-${index}.txt`,
      content: `turn ${index} preserved content\n`,
    };
  });
}

function editPrompt(turn: ClaudeTurnSpec): string {
  return [
    `${turn.promptToken}.`,
    `Use the Write tool, not Bash, to create ${turn.fileName} with exactly:`,
    "```",
    turn.content.trimEnd(),
    "```",
    `When the file is saved, reply exactly: ${turn.doneToken}`,
  ].join("\n");
}

async function sendClaudeWriteTurn(
  harness: ClaudeRewindHarness,
  session: ClaudeRewindSession,
  turn: ClaudeTurnSpec,
): Promise<void> {
  await harness.client.sendMessage(session.agentId, editPrompt(turn));
  const finish = await harness.client.waitForFinish(session.agentId, TURN_TIMEOUT_MS);
  expect(finish.status).toBe("idle");
  expect(finish.final?.lastError).toBeUndefined();
  await expect(fileExists(path.join(session.cwd, turn.fileName))).resolves.toBe(true);
}

async function runtimeSessionId(
  harness: ClaudeRewindHarness,
  session: ClaudeRewindSession,
): Promise<string | null> {
  const snapshot = await harness.client.fetchAgent(session.agentId);
  return snapshot?.agent.runtimeInfo?.sessionId ?? snapshot?.agent.persistence?.sessionId ?? null;
}

function roleItems(items: AgentTimelineItem[], role: "user_message" | "assistant_message") {
  return items.filter((item) => item.type === role);
}

async function assertFiles(
  session: ClaudeRewindSession,
  turns: ClaudeTurnSpec[],
  expectedPresent: ClaudeTurnSpec[],
): Promise<void> {
  const expectedNames = new Set(expectedPresent.map((turn) => turn.fileName));
  for (const turn of turns) {
    await expect(fileExists(path.join(session.cwd, turn.fileName))).resolves.toBe(
      expectedNames.has(turn.fileName),
    );
  }
}

function assertTimeline(
  items: AgentTimelineItem[],
  turns: ClaudeTurnSpec[],
  expectedKept: ClaudeTurnSpec[],
): void {
  const userItems = roleItems(items, "user_message");
  const userText = textByRole(items, "user_message");
  const assistantText = textByRole(items, "assistant_message");
  const keptPromptTokens = new Set(expectedKept.map((turn) => turn.promptToken));

  expect(userItems).toHaveLength(expectedKept.length);
  for (const turn of turns) {
    if (keptPromptTokens.has(turn.promptToken)) {
      expect(userText).toContain(turn.promptToken);
      expect(assistantText).toContain(turn.doneToken);
    } else {
      expect(userText).not.toContain(turn.promptToken);
      expect(assistantText).not.toContain(turn.doneToken);
    }
  }
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

  test.each(MATRIX)(
    "$name",
    async (scenario) => {
      const session = await launchClaudeRewindSession(
        harness,
        `claude-rewind-${scenario.mode}-${scenario.turnCount}-${scenario.rewindTurn}`,
      );
      const turns = buildTurns(scenario);

      try {
        for (const turn of turns) {
          await sendClaudeWriteTurn(harness, session, turn);
        }

        const beforeTimeline = await fetchTimelineItems(harness.client, session.agentId);
        const targetTurn = turns[scenario.rewindTurn - 1];
        const targetMessageId = userMessageIdForToken(beforeTimeline, targetTurn.promptToken);
        const sessionIdBefore = await runtimeSessionId(harness, session);
        expect(sessionIdBefore).toEqual(expect.any(String));

        await harness.client.rewindAgent(session.agentId, targetMessageId, scenario.mode);

        const afterTimeline = await fetchTimelineItems(harness.client, session.agentId);
        const sessionIdAfter = await runtimeSessionId(harness, session);
        const expectedKeptConversation =
          scenario.mode === "files" ? turns : turns.slice(0, scenario.rewindTurn - 1);
        const expectedKeptFiles =
          scenario.mode === "conversation" ? turns : turns.slice(0, scenario.rewindTurn - 1);

        assertTimeline(afterTimeline, turns, expectedKeptConversation);
        await assertFiles(session, turns, expectedKeptFiles);

        if (scenario.mode === "files") {
          expect(sessionIdAfter).toBe(sessionIdBefore);
        } else {
          expect(sessionIdAfter).toEqual(expect.any(String));
          expect(sessionIdAfter).not.toBe(sessionIdBefore);
        }

        const snapshot = await harness.client.fetchAgent(session.agentId);
        expect(snapshot?.agent.status).toBe("idle");
        expect(snapshot?.agent.pendingPermissions).toEqual([]);
      } finally {
        await closeClaudeRewindSession(session);
      }
    },
    420_000,
  );
});
