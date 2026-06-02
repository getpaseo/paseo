import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";

import type { AgentClient, PersistedAgentDescriptor } from "../agent/agent-sdk-types.js";
import { OpenCodeServerManager } from "../agent/providers/opencode/server-manager.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { canRunRealProvider, createRealProviderClient } from "./real-provider-test-config.js";

function tmpCwd(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "daemon-real-opencode-draft-features-"));
  return realpathSync(dir);
}

async function withConnectedOpenCodeDaemon(
  provider: AgentClient,
  run: (context: { client: DaemonClient }) => Promise<void>,
): Promise<void> {
  const logger = pino({ level: "silent" });
  const daemon = await createTestPaseoDaemon({
    agentClients: { opencode: provider },
    logger,
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });

  try {
    await client.connect();
    await client.fetchAgents({
      subscribe: { subscriptionId: `opencode-draft-features-${randomUUID()}` },
    });
    await run({ client });
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close().catch(() => undefined);
  }
}

async function deletePersistedSessions(
  provider: AgentClient,
  sessions: ReadonlyArray<PersistedAgentDescriptor>,
): Promise<void> {
  await Promise.all(
    sessions.map(async (session) => {
      const resumed = await provider.resumeSession(session.persistence);
      await resumed.close();
    }),
  );
}

describe("daemon E2E (real opencode) - draft feature discovery", () => {
  let canRun = false;

  beforeAll(async () => {
    canRun = await canRunRealProvider("opencode");
  });

  beforeEach((context) => {
    if (!canRun) {
      context.skip();
    }
  });

  test("listing draft features does not leave an OpenCode provider session behind", async () => {
    const logger = pino({ level: "silent" });
    const provider = createRealProviderClient("opencode", logger);
    const cwd = tmpCwd();
    let after: PersistedAgentDescriptor[] = [];

    try {
      expect(await provider.listPersistedAgents?.({ cwd })).toEqual([]);

      await withConnectedOpenCodeDaemon(provider, async ({ client }) => {
        const response = await client.listProviderFeatures({
          provider: "opencode",
          cwd,
          title: "OpenCode draft feature discovery",
        });

        expect(response.error).toBeNull();
        expect(response.features ?? []).toEqual([]);
      });

      after = (await provider.listPersistedAgents?.({ cwd })) ?? [];
    } finally {
      await deletePersistedSessions(provider, after);
      rmSync(cwd, { recursive: true, force: true });
      await OpenCodeServerManager.getInstance(logger).shutdown();
    }

    expect(after).toEqual([]);
  }, 60_000);

  test("listing draft commands does not leave an OpenCode provider session behind", async () => {
    const logger = pino({ level: "silent" });
    const provider = createRealProviderClient("opencode", logger);
    const cwd = tmpCwd();
    let after: PersistedAgentDescriptor[] = [];

    try {
      expect(await provider.listPersistedAgents?.({ cwd })).toEqual([]);

      await withConnectedOpenCodeDaemon(provider, async ({ client }) => {
        const response = await client.listCommands("draft-opencode-agent", {
          draftConfig: {
            provider: "opencode",
            cwd,
          },
        });

        expect(response.error).toBeNull();
        expect(response.commands.length).toBeGreaterThan(0);
      });

      after = (await provider.listPersistedAgents?.({ cwd })) ?? [];
    } finally {
      await deletePersistedSessions(provider, after);
      rmSync(cwd, { recursive: true, force: true });
      await OpenCodeServerManager.getInstance(logger).shutdown();
    }

    expect(after).toEqual([]);
  }, 60_000);
});
