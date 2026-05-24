import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { ClaudeAgentClient } from "../agent/providers/claude/agent.js";
import { CodexAppServerAgentClient } from "../agent/providers/codex-app-server-agent.js";
import { OpenCodeAgentClient } from "../agent/providers/opencode-agent.js";
import { PiRpcAgentClient } from "../agent/providers/pi/agent.js";
import type {
  AgentClient,
  AgentProvider,
  AgentSessionConfig,
  AgentStreamEvent,
} from "../agent/agent-sdk-types.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { getFullAccessConfig, isProviderAvailable } from "./agent-configs.js";
import { fetchTimelineItems } from "./test-utils/rewind-helpers.js";

type ContractProvider = Extract<AgentProvider, "claude" | "codex" | "opencode" | "pi">;

interface ProviderContractCase {
  provider: ContractProvider;
  title: string;
  timeoutMs: number;
  createClient: (logger: pino.Logger) => AgentClient;
  createConfig: () => AgentSessionConfig;
}

const PI_REAL_TEST_MODEL = "openrouter/google/gemini-2.5-flash-lite";

const CONTRACT_CASES: ProviderContractCase[] = [
  {
    provider: "claude",
    title: "Claude",
    timeoutMs: 180_000,
    createClient: (logger) => new ClaudeAgentClient({ logger }),
    createConfig: () => getFullAccessConfig("claude"),
  },
  {
    provider: "codex",
    title: "Codex",
    timeoutMs: 180_000,
    createClient: (logger) => new CodexAppServerAgentClient(logger),
    createConfig: () => getFullAccessConfig("codex"),
  },
  {
    provider: "opencode",
    title: "OpenCode",
    timeoutMs: 180_000,
    createClient: (logger) => new OpenCodeAgentClient(logger),
    createConfig: () => getFullAccessConfig("opencode"),
  },
  {
    provider: "pi",
    title: "Pi",
    timeoutMs: 240_000,
    createClient: (logger) => new PiRpcAgentClient({ logger }),
    createConfig: () => ({
      provider: "pi",
      model: PI_REAL_TEST_MODEL,
      thinkingOptionId: "medium",
    }),
  },
];

function tmpCwd(provider: ContractProvider): string {
  return mkdtempSync(path.join(tmpdir(), `daemon-real-${provider}-user-message-contract-`));
}

function collectUserMessageEvents(client: DaemonClient, agentId: string): AgentStreamEvent[] {
  const events: AgentStreamEvent[] = [];
  client.on("agent_stream", (message) => {
    if (message.type !== "agent_stream" || message.payload.agentId !== agentId) {
      return;
    }
    if (message.payload.event.type !== "timeline") {
      return;
    }
    if (message.payload.event.item.type !== "user_message") {
      return;
    }
    events.push(message.payload.event);
  });
  return events;
}

describe.each(CONTRACT_CASES)("daemon E2E (real $provider) - user_message contract", (entry) => {
  let canRun = false;
  let daemon: TestPaseoDaemon | null = null;
  let client: DaemonClient | null = null;
  let cwd: string | null = null;

  beforeAll(async () => {
    canRun = await isProviderAvailable(entry.provider);
  });

  beforeEach(async (context) => {
    if (!canRun) {
      context.skip();
      return;
    }

    cwd = tmpCwd(entry.provider);
    const logger = pino({ level: "silent" });
    daemon = await createTestPaseoDaemon({
      agentClients: { [entry.provider]: entry.createClient(logger) },
      logger,
    });
    client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      appVersion: "0.1.80",
    });
    await client.connect();
    await client.fetchAgents({ subscribe: { subscriptionId: `${entry.provider}-user-contract` } });
  }, 30_000);

  afterEach(async () => {
    await client?.close().catch(() => undefined);
    await daemon?.close().catch(() => undefined);
    if (cwd) {
      rmSync(cwd, { recursive: true, force: true });
    }
    client = null;
    daemon = null;
    cwd = null;
  });

  test(
    "submit one prompt emits exactly one provider user_message",
    async () => {
      if (!client || !cwd) {
        throw new Error(`${entry.title} user-message contract test was not initialized`);
      }

      const prompt = `PASEO_USER_MESSAGE_CONTRACT_${entry.provider.toUpperCase()}. Reply exactly: OK.`;
      const agent = await client.createAgent({
        cwd,
        title: `${entry.provider}-user-message-contract`,
        ...entry.createConfig(),
      });
      const liveUserEvents = collectUserMessageEvents(client, agent.id);

      await client.sendMessage(agent.id, prompt);
      const finish = await client.waitForFinish(agent.id, entry.timeoutMs);
      expect(finish.status).toBe("idle");
      expect(finish.final?.lastError).toBeUndefined();

      const liveUserMessages = liveUserEvents.filter(
        (event) => event.type === "timeline" && event.item.type === "user_message",
      );
      expect(liveUserMessages).toHaveLength(1);
      const [liveUserMessage] = liveUserMessages;
      expect(liveUserMessage?.type).toBe("timeline");
      expect(liveUserMessage?.item.type).toBe("user_message");
      expect(liveUserMessage?.item.text).toBe(prompt);
      expect(liveUserMessage?.item.messageId).toEqual(expect.any(String));
      expect(liveUserMessage?.item.messageId).not.toBe("");

      const timeline = await fetchTimelineItems(client, agent.id);
      const canonicalUserMessages = timeline.filter((item) => item.type === "user_message");
      expect(canonicalUserMessages).toHaveLength(1);
      expect(canonicalUserMessages[0]?.text).toBe(prompt);
      expect(canonicalUserMessages[0]?.messageId).toBe(liveUserMessage?.item.messageId);
    },
    entry.timeoutMs + 60_000,
  );
});
