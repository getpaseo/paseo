import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { expect, test } from "vitest";

import type { AgentClient, AgentSessionConfig } from "../agent/agent-sdk-types.js";
import { ClaudeAgentClient } from "../agent/providers/claude/agent.js";
import { CodexAppServerAgentClient } from "../agent/providers/codex-app-server-agent.js";
import { OpenCodeServerManager } from "../agent/providers/opencode/server-manager.js";
import { OpenCodeAgentClient } from "../agent/providers/opencode-agent.js";
import {
  getRealProviderConfig,
  getRealProviderRuntimeSettings,
} from "./real-provider-test-config.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";

type NativeProvider = "claude" | "codex" | "opencode";

interface ReloadConversation {
  rememberToken: () => Promise<string>;
  reloadAndRecallToken: (sessionId: string) => Promise<void>;
}

async function withNativeConversation(
  provider: NativeProvider,
  run: (conversation: ReloadConversation) => Promise<void>,
): Promise<void> {
  const secret = `RELOAD_${provider.toUpperCase()}_7F31`;
  const root = mkdtempSync(path.join(tmpdir(), `paseo-reload-${provider}-`));
  const cwd = path.join(root, "workspace");
  mkdirSync(cwd);
  const logger = pino({ level: "warn" });
  let daemon: TestPaseoDaemon | undefined;
  let client: DaemonClient | undefined;
  let openCode: OpenCodeAgentClient | undefined;
  let openCodeRuntimeRoot: string | undefined;
  try {
    let providerClient: AgentClient;
    let config: Partial<AgentSessionConfig>;
    if (provider === "claude") {
      providerClient = new ClaudeAgentClient({ logger });
      config = { model: "haiku", modeId: "bypassPermissions" };
    } else if (provider === "codex") {
      providerClient = new CodexAppServerAgentClient(logger);
      config = { modeId: "full-access", thinkingOptionId: "low" };
    } else {
      const settings = getRealProviderRuntimeSettings("opencode");
      openCodeRuntimeRoot = path.dirname(settings.env!.XDG_CONFIG_HOME!);
      openCode = new OpenCodeAgentClient(logger, settings, {
        serverManager: new OpenCodeServerManager({ logger, runtimeSettings: settings }),
      });
      providerClient = openCode;
      config = getRealProviderConfig("opencode");
    }
    daemon = await createTestPaseoDaemon({
      agentClients: { [provider]: providerClient },
      logger,
      pluginsEnabled: false,
    });
    client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.7.2" });
    await client.connect();
    await client.fetchAgents({ subscribe: { subscriptionId: "native-reload-qa" } });
    const agent = await client.createAgent({ provider, cwd, ...config });
    process.stdout.write(`${provider}: model=${agent.model ?? "default"}\n`);
    const manager = daemon.daemon.agentManager;
    const connectedClient = client;
    await run({
      rememberToken: async () => {
        const first = await manager.runAgent(
          agent.id,
          `Remember this token for this conversation: ${secret}. Reply with exactly that token. Do not use tools.`,
        );
        expect(first.finalText).toContain(secret);
        const handle = manager.getAgent(agent.id)?.persistence;
        expect(handle?.sessionId).toBeTruthy();
        process.stdout.write(`${provider}: first real turn passed; session=${handle!.sessionId}\n`);
        return handle!.sessionId;
      },
      reloadAndRecallToken: async (sessionId: string) => {
        for (let round = 1; round <= 3; round++) {
          await connectedClient.refreshAgent(agent.id);
          expect(manager.getAgent(agent.id)?.persistence?.sessionId).toBe(sessionId);
          const response = await manager.runAgent(
            agent.id,
            "What token did I ask you to remember? Reply with only that token. Do not use tools.",
          );
          expect(response.finalText).toContain(secret);
          const timeline = await connectedClient.fetchAgentTimeline(agent.id, {
            direction: "tail",
            limit: 0,
            projection: "canonical",
          });
          expect(
            timeline.entries.some(
              ({ item }) => item.type === "assistant_message" && item.text.includes(secret),
            ),
          ).toBe(true);
          process.stdout.write(
            `${provider}: refresh ${round}/3 passed; same session; memory recalled; timeline present\n`,
          );
        }
      },
    });
    await manager.closeAgent(agent.id);
  } finally {
    await client?.close();
    await daemon?.close();
    await openCode?.shutdown();
    if (openCodeRuntimeRoot) rmSync(openCodeRuntimeRoot, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
}

// Opt in: real requests using local Claude/Codex auth and the OpenRouter test setup.
test
  .runIf(process.env.PASEO_NATIVE_RELOAD_QA === "1")
  .each(["claude", "codex", "opencode"] as const)(
  "%s retains its session and conversation through repeated refresh RPCs",
  async (provider) => {
    await withNativeConversation(provider, async (conversation) => {
      const sessionId = await conversation.rememberToken();
      await conversation.reloadAndRecallToken(sessionId);
    });
  },
  180_000,
);
