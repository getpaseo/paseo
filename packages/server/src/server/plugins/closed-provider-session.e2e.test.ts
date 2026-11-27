import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { resolveDaemonVersion } from "../daemon-version.js";

const PROVIDER_ID = "closing-provider";
const PLUGIN_ID = "closing-provider-plugin";

// How the provider ends the session that ran the first turn.
type CloseMode =
  // The first turn completes, then the provider closes the session on its own.
  | "after-turn"
  // The first turn fails and the provider closes the session with the failure.
  | "after-failed-turn"
  // The provider answers the second prompt by closing the session.
  | "on-next-prompt";

async function createClosingProviderPlugin(root: string, mode: CloseMode): Promise<string> {
  const directory = path.join(root, "plugin");
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "paseo-plugin.json"),
    JSON.stringify({
      id: PLUGIN_ID,
      requirements: { paseo: `>=${resolveDaemonVersion(import.meta.url)}` },
    }),
  );
  await writeFile(
    path.join(directory, "index.server.ts"),
    `import type {
  ProviderEvent,
  ProviderInput,
  ProviderRegistration,
} from "@getpaseo/plugin/server/provider";

const CAPABILITIES = ["prompt.message", "session.persistence"];
const MODE = ${JSON.stringify(mode)};

const provider: ProviderRegistration = {
  id: ${JSON.stringify(PROVIDER_ID)},
  label: "Closing provider",
  async connect() {
    let listener: ((event: ProviderEvent) => void) | null = null;
    const emit = (event: ProviderEvent) => listener?.(event);
    let turn = 0;
    const closed = new Set<string>();
    return {
      version: 1,
      capabilities: CAPABILITIES,
      async send(input: ProviderInput) {
        if (input.type === "catalog") {
          emit({
            type: "catalog",
            requestId: input.requestId,
            catalog: {
              models: [{ id: "closing-model", label: "Closing model" }],
              modes: [],
              thinkingOptions: [],
              defaultModel: "closing-model",
            },
          });
          return;
        }
        if (input.type === "session.open") {
          emit({
            type: "session.opened",
            requestId: input.requestId,
            sessionId: input.sessionId,
            capabilities: CAPABILITIES,
            restoration: "core",
            persistence: { version: 1, data: { token: "root" } },
            cwd: input.config.cwd,
          });
          emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
          return;
        }
        if (input.type === "session.prompt") {
          turn += 1;
          if (MODE === "on-next-prompt" && turn === 2) {
            closed.add(input.sessionId);
            emit({ type: "session.closed", sessionId: input.sessionId });
            return;
          }
          const turnId = "turn-" + turn;
          emit({
            type: "session.prompt_result",
            sessionId: input.sessionId,
            clientMessageId: input.prompt.clientMessageId,
            result: { type: "turn", turnId },
          });
          emit({ type: "session.turn", sessionId: input.sessionId, turnId, state: "started" });
          if (MODE === "after-failed-turn" && turn === 1) {
            emit({ type: "session.turn", sessionId: input.sessionId, turnId, state: "failed", error: { message: "Provider turn failed" } });
            emit({ type: "session.closed", sessionId: input.sessionId, error: { message: "Provider turn failed" } });
            return;
          }
          emit({
            type: "timeline.item",
            sessionId: input.sessionId,
            item: { type: "assistant_message", id: "answer-" + turn, text: "Done " + turn },
          });
          emit({ type: "session.turn", sessionId: input.sessionId, turnId, state: "completed" });
          if (MODE === "after-turn" && turn === 1) {
            emit({ type: "session.closed", sessionId: input.sessionId });
          }
          return;
        }
        if (input.type === "session.close") {
          if (!closed.has(input.sessionId)) emit({ type: "session.closed", sessionId: input.sessionId });
        }
        if ("requestId" in input) {
          emit({ type: "request.completed", requestId: input.requestId });
        }
      },
      onEvent(next: (event: ProviderEvent) => void) {
        listener = next;
        return () => {
          if (listener === next) listener = null;
        };
      },
      async close() {},
    };
  },
};

export default function contribute(server: { registerProvider(p: ProviderRegistration): void }) {
  server.registerProvider(provider);
  return () => undefined;
}`,
  );
  return directory;
}

test.each<CloseMode>(["after-turn", "after-failed-turn", "on-next-prompt"])(
  "an agent whose provider session closed (%s) runs its next prompt",
  async (mode) => {
    const root = await mkdtemp(path.join(tmpdir(), "plugin-provider-closed-session-"));
    onTestFinished(() =>
      rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
    );
    const pluginDirectory = await createClosingProviderPlugin(root, mode);
    const workspace = path.join(root, "workspace");
    await mkdir(workspace, { recursive: true });

    const daemon = await createTestPaseoDaemon({
      paseoHomeRoot: path.join(root, "daemon"),
      staticDir: path.join(root, "static"),
      pluginsEnabled: true,
      plugins: {
        [PLUGIN_ID]: { source: "directory", path: pluginDirectory, enabled: true },
      },
    });
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      appVersion: "0.9.1",
    });
    onTestFinished(async () => {
      await client.close();
      await daemon.close();
    });
    await client.connect();
    await client.fetchAgents({ subscribe: {} });

    const agent = await client.createAgent({
      provider: PROVIDER_ID,
      model: "closing-model",
      cwd: workspace,
      title: "Closing provider agent",
    });
    await client.sendMessage(agent.id, "first");
    await client.waitForFinish(agent.id, 30_000);

    // Before the fix, reopening tried to close the session the provider had already
    // closed, failed, and rejected this send with "Provider session <id> is stale".
    await client.sendMessage(agent.id, "second");
    expect((await client.waitForFinish(agent.id, 30_000)).status).toBe("idle");

    const timeline = await client.fetchAgentTimeline(agent.id, {
      direction: "tail",
      limit: 0,
      projection: "canonical",
    });
    const text = JSON.stringify(timeline.entries);
    // In on-next-prompt the provider closed the session on prompt 2, so the reopened
    // session answers the retried prompt as its third.
    expect(text).toContain(mode === "on-next-prompt" ? "Done 3" : "Done 2");
    expect(text).not.toMatch(/Provider session \S+ (closed|is stale)/);
  },
  60_000,
);
