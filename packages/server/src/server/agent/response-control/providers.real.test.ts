import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { AgentManager } from "../agent-manager.js";
import { AgentStorage } from "../agent-storage.js";
import { ClaudeAgentClient } from "../providers/claude/agent.js";
import { CodexAppServerAgentClient } from "../providers/codex-app-server-agent.js";
import { OpenCodeAgentClient } from "../providers/opencode-agent.js";
import { PiRpcAgentClient } from "../providers/pi/agent.js";
import type { AgentClient } from "../agent-sdk-types.js";
import { parseResponseFooter } from "@getpaseo/protocol/response-control/footer";

const logger = createTestLogger();
const providers: Array<{ provider: string; create: () => AgentClient; model?: string }> = [
  { provider: "claude", create: () => new ClaudeAgentClient({ logger }), model: "haiku" },
  { provider: "codex", create: () => new CodexAppServerAgentClient(logger) },
  { provider: "opencode", create: () => new OpenCodeAgentClient(logger) },
  { provider: "pi", create: () => new PiRpcAgentClient({ logger }) },
];

test.skipIf(process.env.PASEO_REAL_RESPONSE_CONTROL !== "1").for(providers)(
  "real $provider final response supplies metadata",
  async ({ provider, create, model }, context) => {
    const client = create();
    if (!(await client.isAvailable())) {
      context.skip();
      return;
    }
    const cwd = await mkdtemp(path.join(tmpdir(), "paseo-response-control-real-"));
    const storage = new AgentStorage(path.join(cwd, "agents"), logger);
    const manager = new AgentManager({
      clients: { [provider]: client },
      providerDefinitions: { [provider]: { enabled: true } },
      registry: storage,
      logger,
    });
    try {
      const agent = await manager.createAgent(
        { provider, cwd, ...(model ? { model } : {}) },
        undefined,
        { workspaceId: undefined },
      );
      await manager.runAgent(
        agent.id,
        "Reply with one short sentence explaining that this is a response-control smoke test. Do not use tools or access files.",
        { signal: AbortSignal.timeout(60_000) },
      );
      const record = await storage.get(agent.id);
      expect(record?.lastError).toBeUndefined();
      expect(
        record?.responseMetadata?.lastTurn?.message,
        (await manager.getLastAssistantMessage(agent.id)) ?? "No assistant response",
      ).toBeTruthy();
      expect(record?.title).toBeTruthy();
      expect(record?.responseMetadata?.icon).toBeTruthy();
      const text = await manager.getLastAssistantMessage(agent.id);
      expect(parseResponseFooter(text ?? "")?.metadata.message).toBe(
        record?.responseMetadata?.lastTurn?.message,
      );
    } finally {
      await Promise.all(manager.listAgents().map((agent) => manager.closeAgent(agent.id)));
      await client.shutdown?.();
      await rm(cwd, { recursive: true, force: true });
    }
  },
  90_000,
);
