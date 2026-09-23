import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { resolveDaemonVersion } from "../daemon-version.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

const PROVIDER_ID = "shutdown-provider";

async function createProviderPlugin(root: string): Promise<string> {
  const directory = path.join(root, "plugin");
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "paseo-plugin.json"),
    JSON.stringify({
      id: "shutdown-provider-plugin",
      requirements: { paseo: `>=${resolveDaemonVersion(import.meta.url)}` },
    }),
  );
  await writeFile(
    path.join(directory, "index.server.ts"),
    `import type { ProviderEvent, ProviderRegistration } from "@getpaseo/plugin/server/provider";

const CAPABILITIES = ["prompt.message", "session.persistence"];

const provider: ProviderRegistration = {
  id: ${JSON.stringify(PROVIDER_ID)},
  label: "Shutdown provider",
  async connect() {
    let listener: ((event: ProviderEvent) => void) | null = null;
    const emit = (event: ProviderEvent) => listener?.(event);
    let turn = 0;
    return {
      version: 1,
      capabilities: CAPABILITIES,
      async send(input: any) {
        if (input.type === "catalog") {
          emit({
            type: "catalog",
            requestId: input.requestId,
            catalog: {
              models: [{ id: "shutdown-model", label: "Shutdown model" }],
              modes: [],
              thinkingOptions: [],
              defaultModel: "shutdown-model",
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
          const turnId = "turn-" + turn;
          emit({
            type: "session.prompt_result",
            sessionId: input.sessionId,
            clientMessageId: input.prompt.clientMessageId,
            result: { type: "turn", turnId },
          });
          emit({ type: "session.turn", sessionId: input.sessionId, turnId, state: "started" });
          emit({
            type: "timeline.item",
            sessionId: input.sessionId,
            item: { type: "assistant_message", id: "answer-" + turn, text: "Done" },
          });
          emit({ type: "session.turn", sessionId: input.sessionId, turnId, state: "completed" });
          return;
        }
        if (input.type === "session.close") {
          emit({ type: "session.closed", sessionId: input.sessionId });
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

test("a clean daemon shutdown leaves a completed plugin-provider agent without an error", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "plugin-provider-shutdown-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const pluginDirectory = await createProviderPlugin(root);
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });

  const daemon = await createTestPaseoDaemon({
    paseoHomeRoot: path.join(root, "daemon"),
    staticDir: path.join(root, "static"),
    cleanup: false,
    pluginsEnabled: true,
    plugins: {
      "shutdown-provider-plugin": { source: "directory", path: pluginDirectory, enabled: true },
    },
  });

  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.9.1" });
  await client.connect();
  await client.fetchAgents({ subscribe: {} });

  const agent = await client.createAgent({
    provider: PROVIDER_ID,
    model: "shutdown-model",
    cwd: workspace,
    title: "Shutdown provider agent",
  });
  await client.sendMessage(agent.id, "hello");
  const finished = await client.waitForFinish(agent.id, 30_000);
  expect(finished.status).toBe("idle");

  const beforeShutdown = await daemon.daemon.agentStorage.get(agent.id);
  expect(beforeShutdown?.lastError ?? null).toBeNull();

  await client.close();
  await daemon.daemon.stop();
  await daemon.daemon.agentStorage.flush().catch(() => undefined);

  const persisted = await daemon.daemon.agentStorage.get(agent.id);
  expect(persisted).not.toBeNull();
  expect(persisted?.lastError ?? null).toBeNull();
  expect(persisted?.attentionReason ?? null).not.toBe("error");
}, 60_000);
