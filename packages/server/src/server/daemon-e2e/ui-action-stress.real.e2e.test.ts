import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";

import type { AgentClient } from "../agent/agent-sdk-types.js";
import { ClaudeAgentClient } from "../agent/providers/claude-agent.js";
import { CodexAppServerAgentClient } from "../agent/providers/codex-app-server-agent.js";
import { OpenCodeAgentClient } from "../agent/providers/opencode-agent.js";
import { createTestJunctionDaemon } from "../test-utils/junction-daemon.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import {
  allProviders,
  getFullAccessConfig,
  isRealProviderReady,
  type AgentProvider,
} from "./agent-configs.js";

type UiAction =
  | {
      type: "ui_enter_submit";
      prompt: string;
      label: string;
    }
  | {
      type: "ui_queue_prompt";
      prompt: string;
      label: string;
    }
  | {
      type: "ui_send_queued_now";
      pick: "first" | "last";
      label: string;
    }
  | {
      type: "wait_ms";
      ms: number;
      label: string;
    }
  | {
      type: "wait_for_running";
      timeoutMs: number;
      label: string;
    }
  | {
      type: "wait_for_finish";
      timeoutMs: number;
      label: string;
    }
  | {
      type: "assert_last_message";
      expectedToken: string;
      forbiddenTokens: string[];
      label: string;
    }
  | {
      type: "assert_last_message_any_of";
      expectedTokens: string[];
      forbiddenTokens: string[];
      label: string;
    }
  | {
      type: "assert_queue_size";
      size: number;
      label: string;
    }
  | {
      type: "assert_queue_size_at_least";
      minSize: number;
      label: string;
    };

type UiScenario = {
  name: string;
  actions: UiAction[];
};

type QueuedPrompt = {
  id: string;
  prompt: string;
};

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-real-ui-action-stress-"));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeMessage(text: string | null): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

function exactTokenPrompt(token: string): string {
  return [
    "Integration test formatting check.",
    `Return exactly this token: ${token}`,
    "Do not include any additional words, punctuation, or formatting.",
  ].join(" ");
}

function longRunningPrompt(sleepSeconds: number, token: string): string {
  return [
    `Use Bash to run the exact command \`sleep ${sleepSeconds}\`.`,
    `After it finishes, respond with exactly: ${token}`,
    "Do not include extra text.",
  ].join(" ");
}

function buildNormalUsageScenario(provider: AgentProvider, seed: number): UiScenario {
  const token1 = `UI_${provider}_${seed}_A`;
  const token2 = `UI_${provider}_${seed}_B`;
  return {
    name: `normal-${provider}-${seed}`,
    actions: [
      {
        type: "ui_enter_submit",
        label: "send first prompt (enter)",
        prompt: exactTokenPrompt(token1),
      },
      { type: "wait_for_finish", label: "wait first", timeoutMs: 180_000 },
      {
        type: "assert_last_message",
        label: "assert first token",
        expectedToken: token1,
        forbiddenTokens: [token2],
      },
      { type: "assert_queue_size", label: "queue remains empty after idle send", size: 0 },
      {
        type: "ui_enter_submit",
        label: "send second prompt (enter)",
        prompt: exactTokenPrompt(token2),
      },
      { type: "wait_for_finish", label: "wait second", timeoutMs: 180_000 },
      {
        type: "assert_last_message",
        label: "assert second token",
        expectedToken: token2,
        forbiddenTokens: [token1],
      },
      { type: "assert_queue_size", label: "queue still empty", size: 0 },
    ],
  };
}

function buildOverlapScenario(
  provider: AgentProvider,
  seed: number,
  firstPick: "first" | "last"
): UiScenario {
  const oldToken = `UI_OLD_${provider}_${seed}`;
  const midToken = `UI_MID_${provider}_${seed}`;
  const latestToken = `UI_LATEST_${provider}_${seed}`;
  const controlToken = `UI_CONTROL_${provider}_${seed}`;
  const firstExpected = firstPick === "first" ? midToken : latestToken;
  const secondExpected = firstPick === "first" ? latestToken : midToken;
  const firstForbidden = [oldToken, secondExpected];
  const secondForbidden = [oldToken, firstExpected];

  if (provider === "opencode") {
    return {
      name: `overlap-${provider}-${seed}-single`,
      actions: [
        {
          type: "ui_enter_submit",
          label: "start long-running turn (enter)",
          prompt: longRunningPrompt(20, oldToken),
        },
        {
          type: "wait_for_running",
          label: "wait until running before queue action",
          timeoutMs: 90_000,
        },
        {
          type: "ui_queue_prompt",
          label: "queue while running (mid)",
          prompt: exactTokenPrompt(midToken),
        },
        {
          type: "assert_queue_size_at_least",
          label: "at least one queued prompt",
          minSize: 1,
        },
        {
          type: "ui_send_queued_now",
          label: "send queued now",
          pick: "first",
        },
        { type: "wait_for_finish", label: "wait after queued-now", timeoutMs: 240_000 },
        {
          type: "assert_last_message_any_of",
          label: "queued-now resolves to active or queued turn",
          expectedTokens: [midToken, oldToken],
          forbiddenTokens: [],
        },
        { type: "assert_queue_size", label: "queue drained", size: 0 },
        {
          type: "ui_enter_submit",
          label: "post-overlap control send",
          prompt: exactTokenPrompt(controlToken),
        },
        { type: "wait_for_finish", label: "wait control", timeoutMs: 180_000 },
        {
          type: "assert_last_message",
          label: "control token",
          expectedToken: controlToken,
          forbiddenTokens: [oldToken, midToken],
        },
      ],
    };
  }

  return {
    name: `overlap-${provider}-${seed}-${firstPick}`,
    actions: [
      {
        type: "ui_enter_submit",
        label: "start long-running turn (enter)",
        prompt: longRunningPrompt(20, oldToken),
      },
      {
        type: "wait_for_running",
        label: "wait until running before queue actions",
        timeoutMs: 90_000,
      },
      {
        type: "ui_queue_prompt",
        label: "queue while running (mid)",
        prompt: exactTokenPrompt(midToken),
      },
      { type: "wait_ms", label: "small user delay", ms: 650 },
      {
        type: "ui_queue_prompt",
        label: "queue while running (latest)",
        prompt: exactTokenPrompt(latestToken),
      },
      { type: "assert_queue_size", label: "two queued prompts", size: 2 },
      {
        type: "ui_send_queued_now",
        label: "send queued now",
        pick: firstPick,
      },
      { type: "wait_for_finish", label: "wait after first queued-now", timeoutMs: 240_000 },
      {
        type: "assert_last_message",
        label: "first queued-now wins without stale drift",
        expectedToken: firstExpected,
        forbiddenTokens: firstForbidden,
      },
      { type: "assert_queue_size", label: "one queued remains", size: 1 },
      {
        type: "ui_send_queued_now",
        label: "send remaining queued prompt",
        pick: "first",
      },
      { type: "wait_for_finish", label: "wait after second queued-now", timeoutMs: 180_000 },
      {
        type: "assert_last_message",
        label: "second queued prompt also executes cleanly",
        expectedToken: secondExpected,
        forbiddenTokens: secondForbidden,
      },
      { type: "assert_queue_size", label: "queue drained", size: 0 },
      {
        type: "ui_enter_submit",
        label: "post-overlap control send",
        prompt: exactTokenPrompt(controlToken),
      },
      { type: "wait_for_finish", label: "wait control", timeoutMs: 180_000 },
      {
        type: "assert_last_message",
        label: "control token",
        expectedToken: controlToken,
        forbiddenTokens: [oldToken, midToken, latestToken],
      },
      { type: "assert_queue_size", label: "queue remains empty at end", size: 0 },
    ],
  };
}

async function resolveLatestAssistantMessage(
  client: DaemonClient,
  agentId: string,
  candidate: string | null
): Promise<string | null> {
  async function findLastAssistantMessageInTimeline(): Promise<string | null> {
    const timeline = await client.fetchAgentTimeline(agentId, {
      direction: "tail",
      limit: 300,
      projection: "canonical",
    });
    for (let idx = timeline.entries.length - 1; idx >= 0; idx -= 1) {
      const entry = timeline.entries[idx];
      if (entry?.item?.type !== "assistant_message") {
        continue;
      }
      const text = normalizeMessage(entry.item.text);
      if (text.length > 0) {
        return entry.item.text;
      }
    }
    return null;
  }

  const normalizedCandidate = normalizeMessage(candidate);
  if (normalizedCandidate.length > 0) {
    return candidate;
  }

  const fromTimeline = await findLastAssistantMessageInTimeline();
  if (fromTimeline) {
    return fromTimeline;
  }

  try {
    await client.refreshAgent(agentId);
  } catch {
    // Best effort only; fallback stays null if refresh fails.
  }

  const fromRefreshedTimeline = await findLastAssistantMessageInTimeline();
  if (fromRefreshedTimeline) {
    return fromRefreshedTimeline;
  }

  return candidate;
}

async function runUiScenario(params: {
  client: DaemonClient;
  agentId: string;
  scenario: UiScenario;
}): Promise<void> {
  const { client, agentId, scenario } = params;
  const queue: QueuedPrompt[] = [];
  let nextQueueId = 0;
  let lastMessage: string | null = null;

  for (const action of scenario.actions) {
    if (action.type === "ui_enter_submit") {
      await client.sendMessage(agentId, action.prompt);
      continue;
    }

    if (action.type === "ui_queue_prompt") {
      nextQueueId += 1;
      queue.push({ id: `queued-${nextQueueId}`, prompt: action.prompt });
      continue;
    }

    if (action.type === "ui_send_queued_now") {
      expect(
        queue.length,
        `[${scenario.name}] ${action.label}: queue must not be empty`
      ).toBeGreaterThan(0);
      const index = action.pick === "last" ? queue.length - 1 : 0;
      const selected = queue.splice(index, 1)[0];
      if (!selected) {
        throw new Error(`[${scenario.name}] ${action.label}: missing queued prompt`);
      }

      // Model UI "send now" as one atomic submit path.
      // The daemon send path interrupts any active run before starting the new one.
      await client.sendMessage(agentId, selected.prompt);
      continue;
    }

    if (action.type === "wait_ms") {
      await sleep(action.ms);
      continue;
    }

    if (action.type === "wait_for_running") {
      await client.waitForAgentUpsert(
        agentId,
        (snapshot) => snapshot.status === "running",
        action.timeoutMs
      );
      continue;
    }

    if (action.type === "wait_for_finish") {
      const result = await client.waitForFinish(agentId, action.timeoutMs);

      expect(
        result.status,
        `[${scenario.name}] ${action.label}: expected idle status`
      ).toBe("idle");
      expect(
        result.error,
        `[${scenario.name}] ${action.label}: unexpected wait_for_finish error`
      ).toBeNull();
      expect(
        result.final?.status,
        `[${scenario.name}] ${action.label}: wait_for_finish returned before run settled`
      ).not.toBe("running");
      lastMessage = await resolveLatestAssistantMessage(
        client,
        agentId,
        result.lastMessage
      );
      continue;
    }

    if (action.type === "assert_last_message") {
      const normalized = normalizeMessage(lastMessage);
      expect(
        normalized,
        `[${scenario.name}] ${action.label}: missing expected token`
      ).toContain(action.expectedToken);
      for (const forbidden of action.forbiddenTokens) {
        expect(
          normalized,
          `[${scenario.name}] ${action.label}: stale token leaked`
        ).not.toContain(forbidden);
      }
      continue;
    }

    if (action.type === "assert_last_message_any_of") {
      const normalized = normalizeMessage(lastMessage);
      const hasAnyExpected = action.expectedTokens.some((token) =>
        normalized.includes(token)
      );
      expect(
        hasAnyExpected,
        `[${scenario.name}] ${action.label}: missing expected tokens (${action.expectedTokens.join(", ")})`
      ).toBe(true);
      for (const forbidden of action.forbiddenTokens) {
        expect(
          normalized,
          `[${scenario.name}] ${action.label}: forbidden token leaked`
        ).not.toContain(forbidden);
      }
      continue;
    }

    if (action.type === "assert_queue_size") {
      expect(
        queue.length,
        `[${scenario.name}] ${action.label}: queue size mismatch`
      ).toBe(action.size);
      continue;
    }

    if (action.type === "assert_queue_size_at_least") {
      expect(
        queue.length,
        `[${scenario.name}] ${action.label}: queue size below expectation`
      ).toBeGreaterThanOrEqual(action.minSize);
      continue;
    }
  }
}

function createRealAgentClient(provider: AgentProvider, logger: pino.Logger): AgentClient {
  if (provider === "claude") {
    return new ClaudeAgentClient({ logger });
  }
  if (provider === "codex") {
    return new CodexAppServerAgentClient(logger);
  }
  return new OpenCodeAgentClient(logger);
}

describe.each(allProviders)(
  "daemon E2E (real %s) - UI action stress",
  (provider) => {
    const shouldRun = isRealProviderReady(provider);

    test.runIf(shouldRun)(
      "normal UI submit path (idle sends) stays correct",
      async () => {
        const logger = pino({ level: "silent" });
        const cwd = tmpCwd();
        const daemon = await createTestJunctionDaemon({
          agentClients: {
            [provider]: createRealAgentClient(provider, logger),
          } as Partial<Record<AgentProvider, AgentClient>>,
          logger,
        });
        const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });

        try {
          await client.connect();
          await client.fetchAgents({
            subscribe: { subscriptionId: `ui-stress-normal-${provider}` },
          });
          const agent = await client.createAgent({
            cwd,
            title: `uist-n-${provider}`,
            ...getFullAccessConfig(provider),
          });

          await runUiScenario({
            client,
            agentId: agent.id,
            scenario: buildNormalUsageScenario(provider, 7),
          });

          await client.deleteAgent(agent.id);
        } finally {
          await client.close();
          await daemon.close();
          rmSync(cwd, { recursive: true, force: true });
        }
      },
      420_000
    );

    test.runIf(shouldRun)(
      "queued-send-now path is stable under overlap",
      async () => {
        const logger = pino({ level: "silent" });
        const cwd = tmpCwd();
        const daemon = await createTestJunctionDaemon({
          agentClients: {
            [provider]: createRealAgentClient(provider, logger),
          } as Partial<Record<AgentProvider, AgentClient>>,
          logger,
        });
        const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
        const scenarios = [
          buildOverlapScenario(provider, 17, "last"),
          buildOverlapScenario(provider, 31, "first"),
        ];

        try {
          await client.connect();
          await client.fetchAgents({
            subscribe: { subscriptionId: `ui-stress-overlap-${provider}` },
          });

          for (const scenario of scenarios) {
            const agent = await client.createAgent({
              cwd,
              title: `uist-o-${provider}`,
              ...getFullAccessConfig(provider),
            });

            await runUiScenario({
              client,
              agentId: agent.id,
              scenario,
            });

            await client.deleteAgent(agent.id);
          }
        } finally {
          await client.close();
          await daemon.close();
          rmSync(cwd, { recursive: true, force: true });
        }
      },
      600_000
    );
  }
);
