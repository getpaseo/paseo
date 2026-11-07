import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { AgentManager } from "./agent-manager.js";
import { buildProviderRegistry } from "./provider-registry.js";
import { AgentStorage } from "./agent-storage.js";
import { createTestLogger } from "../../test-utils/test-logger.js";

// A real ACP subprocess: cancel is delivered, but the prompt response is
// deliberately withheld. This models the reported protocol condition rather
// than a particular provider's reason for failing to finish its prompt.
const agentSource = `
import { Readable, Writable } from 'node:stream';
const { AgentSideConnection, PROTOCOL_VERSION, ndJsonStream } = await import(process.env.ACP_SDK_URL);
let finishPrompt;
new AgentSideConnection(() => ({
  async initialize() { return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} }; },
  async newSession() { return { sessionId: 'cancel-ownership-session' }; },
  async authenticate() {},
  prompt() { return new Promise(resolve => { finishPrompt = resolve; }); },
  async cancel() {
    if (process.env.SETTLE_ON_CANCEL === 'true') finishPrompt({ stopReason: 'cancelled' });
  },
}), ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
`;

for (const settles of [true, false]) {
  test(`cancel preserves truthful ownership when ACP prompt settles=${settles}`, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "acp-cancel-ownership-"));
    const script = path.join(dir, "agent.mjs");
    await writeFile(script, agentSource);
    const logger = createTestLogger();
    const registry = buildProviderRegistry(logger, {
      providerOverrides: {
        "cancel-probe": {
          extends: "acp",
          label: "Cancel probe",
          command: [process.execPath, script],
          env: {
            ACP_SDK_URL: pathToFileURL(
              createRequire(import.meta.url).resolve("@agentclientprotocol/sdk"),
            ).href,
            SETTLE_ON_CANCEL: String(settles),
          },
        },
      },
    });
    const manager = new AgentManager({
      clients: { "cancel-probe": registry["cancel-probe"].createClient(logger) },
      registry: new AgentStorage(path.join(dir, "agents"), logger),
      logger,
    });
    let agentId: string | undefined;
    try {
      const agent = await manager.createAgent({ provider: "cancel-probe", cwd: dir }, undefined, {
        workspaceId: undefined,
      });
      agentId = agent.id;
      const first = manager.runAgent(agent.id, "hold this turn until cancellation");
      await manager.waitForAgentRunStart(agent.id);
      const cancellation = await manager.cancelAgentRun(agent.id);
      // Record the consumer-visible symptom before the regression assertion.
      if (!settles && cancellation.status === "settled") {
        await first;
        expect(manager.getAgent(agent.id)?.lifecycle).toBe("idle");
        await expect(manager.runAgent(agent.id, "try again")).rejects.toThrow(
          "A foreground turn is already active",
        );
      }
      expect(cancellation).toEqual({ status: settles ? "settled" : "refused" });
      if (settles) await first;
      else void first.catch(() => undefined);
    } finally {
      if (agentId) await manager.closeAgent(agentId);
      await rm(dir, { recursive: true, force: true });
    }
  });
}
