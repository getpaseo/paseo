import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";

function isGrokInstalled(): boolean {
  try {
    return execFileSync("which", ["grok"], { encoding: "utf8" }).trim().length > 0;
  } catch {
    return false;
  }
}

const grokAvailable = isGrokInstalled();

describe.skipIf(!grokAvailable)("Grok usage through a live Paseo daemon", () => {
  let daemon: TestPaseoDaemon;
  let client: DaemonClient;
  let cwd: string;

  beforeAll(async () => {
    cwd = mkdtempSync(path.join(tmpdir(), "paseo-grok-usage-"));
    daemon = await createTestPaseoDaemon({
      agentClients: {},
      mcpEnabled: false,
      providerOverrides: {
        grok: {
          extends: "acp",
          label: "Grok",
          command: ["grok", "agent", "--always-approve", "stdio"],
        },
      },
    });
    client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      appVersion: "0.4.0",
    });
    await client.connect();
    await client.fetchAgents({ subscribe: { subscriptionId: "grok-usage" } });
  }, 30_000);

  afterAll(async () => {
    await client?.close().catch(() => undefined);
    await daemon?.close().catch(() => undefined);
    rmSync(cwd, { recursive: true, force: true });
  });

  test("provider.usage.list returns SuperGrok Heavy weekly limit", async () => {
    const payload = await client.listProviderUsage();
    const grok = payload.providers.find((provider) => provider.providerId === "grok");

    expect(grok).toMatchObject({
      providerId: "grok",
      displayName: "Grok",
      status: "available",
      planLabel: "SuperGrok Heavy",
    });
    expect(grok?.windows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "weekly",
          label: "Weekly",
          usedPct: expect.any(Number),
          remainingPct: expect.any(Number),
          resetsAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        }),
      ]),
    );
    expect(grok?.windows[0]?.usedPct).toBeGreaterThanOrEqual(0);
    expect(grok?.windows[0]?.usedPct).toBeLessThanOrEqual(100);
  }, 30_000);

  test("a Grok turn publishes context-window usage onto the agent snapshot", async () => {
    const workspace = await client.createWorkspace({
      source: { kind: "directory", path: cwd },
    });
    if (!workspace.workspace) {
      throw new Error(workspace.error ?? "failed to create workspace");
    }

    const created = await client.createAgent({
      provider: "grok",
      cwd,
      workspaceId: workspace.workspace.id,
      title: "Grok usage live test",
      initialPrompt: "Reply with exactly the word pong and nothing else.",
    });

    const snapshot = await client.waitForAgentUpsert(
      created.id,
      (agent) =>
        agent.lastUsage?.contextWindowMaxTokens === 500_000 &&
        typeof agent.lastUsage.contextWindowUsedTokens === "number" &&
        agent.lastUsage.contextWindowUsedTokens >= 0,
      180_000,
    );

    expect(snapshot.lastUsage).toEqual(
      expect.objectContaining({
        contextWindowMaxTokens: 500_000,
        contextWindowUsedTokens: expect.any(Number),
      }),
    );
    expect(snapshot.lastUsage?.contextWindowUsedTokens).toBeLessThan(500_000);
  }, 180_000);
});
