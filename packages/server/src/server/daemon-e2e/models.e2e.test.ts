import { describe, test, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { findExecutable } from "../../executable-resolution/executable-resolution.js";
import { BuiltinPluginLoader } from "../plugins/builtin/index.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { execFileSync } from "node:child_process";
import { createDaemonTestContext } from "../test-utils/index.js";

function isBinaryInstalled(binary: string): boolean {
  try {
    const out = execFileSync("which", [binary], { encoding: "utf8" }).trim();
    return out.length > 0;
  } catch {
    return false;
  }
}

const hasCodex = isBinaryInstalled("codex");
const hasOpenCode = isBinaryInstalled("opencode");

describe("daemon E2E", () => {
  describe("listProviderModels", () => {
    test.runIf(hasCodex)(
      "returns model list for Codex provider",
      async () => {
        const ctx = await createDaemonTestContext();
        try {
          // List models for Codex provider - no agent needed
          const result = await ctx.client.listProviderModels("codex");

          // Verify response structure
          expect(result.provider).toBe("codex");
          expect(result.error).toBeNull();
          expect(result.fetchedAt).toBeTruthy();

          // Should return at least one model
          expect(result.models).toBeTruthy();
          expect(result.models.length).toBeGreaterThan(0);

          // Verify model structure
          const model = result.models[0];
          expect(model.provider).toBe("codex");
          expect(model.id).toBeTruthy();
          expect(model.label).toBeTruthy();
        } finally {
          await ctx.cleanup();
        }
      },
      60000, // 1 minute timeout
    );

    test("returns model list for Claude provider", async () => {
      const ctx = await createDaemonTestContext();
      try {
        // List models for Claude provider - no agent needed
        const result = await ctx.client.listProviderModels("claude");

        // Verify response structure
        expect(result.provider).toBe("claude");
        expect(result.error).toBeNull();
        expect(result.fetchedAt).toBeTruthy();

        // Should return at least one model
        expect(result.models).toBeTruthy();
        expect(result.models.length).toBeGreaterThan(0);

        // Verify model structure
        const model = result.models[0];
        expect(model.provider).toBe("claude");
        expect(model.id).toBeTruthy();
        expect(model.label).toBeTruthy();
      } finally {
        await ctx.cleanup();
      }
    }, 180000);

    test.runIf(hasOpenCode)(
      "returns model list for OpenCode provider",
      async () => {
        const ctx = await createDaemonTestContext();
        try {
          const result = await ctx.client.listProviderModels("opencode");

          expect(result.provider).toBe("opencode");
          expect(result.error).toBeNull();
          expect(result.fetchedAt).toBeTruthy();

          expect(result.models).toBeTruthy();
          expect(result.models.length).toBeGreaterThan(0);

          const model = result.models[0];
          expect(model.provider).toBe("opencode");
          expect(model.id).toBeTruthy();
          expect(model.label).toBeTruthy();
        } finally {
          await ctx.cleanup();
        }
      },
      60000,
    );
  });
});

test("Antigravity creates an agent and answers a prompt with real agy", async ({ skip }) => {
  const command = await findExecutable(process.env.AGY_COMMAND ?? "agy");
  if (command === null) {
    skip("agy is not resolvable");
    return;
  }
  const cwd = await mkdtemp(path.join(os.tmpdir(), "paseo-antigravity-e2e-"));
  const daemon = await createTestPaseoDaemon({
    agentClients: {},
    mcpEnabled: false,
    builtinPlugins: new BuiltinPluginLoader(undefined, ["antigravity-provider"]),
    providerOverrides: { antigravity: { command: [command], paseoTools: { enabled: false } } },
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.10.0",
  });
  try {
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    await expect
      .poll(
        async () => {
          const snapshot = await client.getProvidersSnapshot({ cwd });
          return snapshot.entries.find((entry) => entry.provider === "antigravity")?.status;
        },
        { timeout: 30000 },
      )
      .toBe("ready");
    const agent = await client.createAgent({
      provider: "antigravity",
      cwd,
      title: "Antigravity E2E",
    });
    await client.sendMessage(agent.id, "Reply with exactly ANTIGRAVITY_E2E_OK. No tools.");
    const result = await client.waitForFinish(agent.id, 90000);
    expect(result.status).toBe("idle");
    const timeline = await client.fetchAgentTimeline(agent.id, { limit: 100 });
    expect(
      timeline.entries.some(
        (entry) =>
          entry.item.type === "assistant_message" && entry.item.text.includes("ANTIGRAVITY_E2E_OK"),
      ),
    ).toBe(true);
  } finally {
    await client.close();
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
}, 120000);
