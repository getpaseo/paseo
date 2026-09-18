import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";

import { getFullAccessConfig } from "./daemon-e2e/agent-configs.js";
import { createDaemonTestContext, type DaemonTestContext } from "./test-utils/index.js";

let ctx: DaemonTestContext;
let cwd: string;

beforeEach(async () => {
  ctx = await createDaemonTestContext();
  cwd = mkdtempSync(path.join(tmpdir(), "create-agent-internal-"));
});

afterEach(async () => {
  await ctx.cleanup();
  rmSync(cwd, { recursive: true, force: true });
});

/** Every agent id with a record under `$PASEO_HOME/agents`, whatever its cwd bucket. */
function storedAgentIds(paseoHome: string): string[] {
  const root = path.join(paseoHome, "agents");
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => path.basename(entry, ".json"));
}

async function listedAgentIds(includeArchived: boolean): Promise<string[]> {
  const payload = await ctx.client.fetchAgents(
    includeArchived ? { filter: { includeArchived } } : {},
  );
  return payload.entries.map((entry) => entry.agent.id);
}

async function historyAgentIds(): Promise<string[]> {
  const payload = await ctx.client.fetchAgentHistory({ page: { limit: 50 } });
  return payload.entries.map((entry) => entry.agent.id);
}

test("an internal agent runs for its caller but reaches no list, history, or storage", async () => {
  const config = { ...getFullAccessConfig("codex"), cwd };
  const visible = await ctx.client.createAgent({ config, initialPrompt: "Say done." });
  const hidden = await ctx.client.createAgent({
    config,
    internal: true,
    initialPrompt: "Say done.",
  });
  expect(hidden.id).not.toBe(visible.id);
  expect(hidden.cwd).toBe(visible.cwd);

  // The caller can still drive it by id.
  const finished = await ctx.client.waitForFinish(hidden.id, 10_000);
  expect(finished).toMatchObject({ status: "idle", error: null });
  await ctx.client.waitForFinish(visible.id, 10_000);

  await expect
    .poll(() => storedAgentIds(ctx.daemon.paseoHome), { timeout: 10_000, interval: 100 })
    .toContain(visible.id);
  expect(storedAgentIds(ctx.daemon.paseoHome)).not.toContain(hidden.id);

  expect(await listedAgentIds(false)).toContain(visible.id);
  expect(await listedAgentIds(false)).not.toContain(hidden.id);
  expect(await listedAgentIds(true)).not.toContain(hidden.id);

  expect(await historyAgentIds()).toContain(visible.id);
  expect(await historyAgentIds()).not.toContain(hidden.id);
}, 30_000);

test("an internal agent can auto-archive without surfacing in archived lists", async () => {
  const config = { ...getFullAccessConfig("codex"), cwd };
  const hidden = await ctx.client.createAgent({
    config,
    internal: true,
    autoArchive: true,
    initialPrompt: "Say done.",
  });
  await ctx.client.waitForFinish(hidden.id, 10_000);

  // Archived internal agents leave no record behind, so "archived" is observable
  // only as the live snapshot carrying archivedAt or being gone altogether.
  await expect
    .poll(
      async () => {
        const result = await ctx.client.fetchAgent(hidden.id).catch(() => null);
        return result === null || result.agent.archivedAt !== null;
      },
      { timeout: 10_000, interval: 100 },
    )
    .toBe(true);

  expect(await listedAgentIds(true)).not.toContain(hidden.id);
  expect(await historyAgentIds()).not.toContain(hidden.id);
  expect(storedAgentIds(ctx.daemon.paseoHome)).not.toContain(hidden.id);
}, 30_000);
