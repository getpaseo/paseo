#!/usr/bin/env npx tsx
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createE2ETestContext } from "./helpers/test-daemon.ts";
import { connectToDaemon } from "../src/utils/client.ts";
import { resolveCliVersion } from "../src/version.ts";

const context = await createE2ETestContext();
try {
  const directory = join(context.workDir, "usage-plugin");
  await mkdir(directory);
  await writeFile(
    join(directory, "paseo-plugin.json"),
    JSON.stringify({
      id: "cli-usage",
      requirements: { paseo: `>=${resolveCliVersion()}` },
    }),
  );
  await writeFile(
    join(directory, "index.server.ts"),
    `
import { z } from 'zod';
export default function contribute(server) {
  const counts = new Map();
  server.registerUsageSource({
    id: 'cli-usage', label: 'CLI usage fixture', input: z.object({ key: z.string() }),
    discover: async () => [
      { key: 'work.account', label: 'Work', input: { key: 'work' } },
      { key: 'personal', input: { key: 'personal' } },
      { key: 'broken', harness: 'Harness A', input: { key: 'rejected' } },
      { key: 'broken', harness: 'Harness B', input: { key: 'expired' } },
      { key: 'error', input: { key: 'error' } },
    ],
    fetch: async ({key}) => {
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (key === 'rejected') return {status: 'unavailable', problem: {kind: 'rejected', status: 401, refreshedBy: 'codex login'}};
      if (key === 'expired') return {status: 'unavailable', problem: {kind: 'expired', expiresAt: '2026-10-08T00:00:00Z', refreshedBy: 'claude'}};
      if (key === 'error') throw new Error('Quota service failed');
      return { status: 'available', planLabel: 'Pro', windows: [
        { id: 'session', label: 'Session', usedPct: counts.get(key), remainingPct: 99, resetsAt: '2026-10-09T17:00:00Z', runsOutAt: '2026-10-09T16:00:00Z', shortfallPct: 4.25 },
        { id: 'weekly', label: 'Weekly', usedPct: null, remainingPct: 0 },
      ], balances: [
        { id: 'credits', label: 'Credits', remaining: 2.5, unit: 'credits' },
        { id: 'tokens', label: 'Tokens', used: 0, limit: 100, unit: 'tokens' },
      ], details: [{ id: 'tier', label: 'Tier', value: 'Enterprise' }] };
    },
  });
  return () => {};
}`,
  );
  const client = await connectToDaemon({ target: { kind: "instance", home: context.paseoHome } });
  try {
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory, "cli-usage");
  } finally {
    await client.close();
  }
  async function ok(args: string[]) {
    const result = await context.paseo(args);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stderr, "");
    return result.stdout;
  }
  // The first usage request is inspect: no earlier usage discovery has populated known IDs.
  const cold = JSON.parse(await ok(["usage", "inspect", "cli-usage:work.account", "--json"]));
  assert.equal(cold.id, "cli-usage:work.account");
  assert.equal(cold.report.windows[0].usedPct, 1);
  for (const args of [
    ["usage", "--agent", "agent-A", "inspect", cold.id, "--json"],
    ["usage", "inspect", cold.id, "--agent", "agent-A", "--json"],
  ]) {
    const conflicting = await context.paseo(args);
    assert.equal(conflicting.exitCode, 1, `Expected selector rejection: ${args.join(" ")}`);
    assert.equal(conflicting.stdout, "");
    assert.deepEqual(JSON.parse(conflicting.stderr).error, {
      code: "INVALID_OPTIONS",
      message:
        "--agent cannot be combined with usage inspect. Use usage ls --agent <id> for agent account usage, or usage inspect <report-id> for an exact report.",
    });
  }

  const list = JSON.parse(await ok(["usage", "ls", "--json"]));
  const defaultList = JSON.parse(await ok(["usage", "--json"]));
  assert.deepEqual(defaultList, list);
  assert.deepEqual(list.map((entry: { id: string }) => entry.id).sort(), [
    "cli-usage:broken",
    "cli-usage:error",
    "cli-usage:personal",
    "cli-usage:work.account",
  ]);
  const work = list.find((entry: { id: string }) => entry.id === cold.id);
  assert.deepEqual(work, cold);
  const table = await ok(["usage", "ls", "--no-color"]);
  for (const text of [
    "REPORT ID",
    "Credits: - used, 2.5 remaining, - limit (credits)",
    "Tokens: 0 used, - remaining, 100 limit (tokens)",
    "Weekly: - used, 0% remaining",
    "Harness A: Login rejected (HTTP 401). Run codex login",
    "Harness B: Login expired at",
    "Quota service failed",
  ])
    assert.ok(table.includes(text), text);
  const quiet = await ok(["usage", "ls", "--quiet"]);
  assert.deepEqual(
    quiet.trim().split("\n").sort(),
    list.map((entry: { id: string }) => entry.id).sort(),
  );
  assert.ok(!(await ok(["usage", "ls", "--no-headers"])).includes("REPORT ID"));
  const detail = await ok(["usage", "inspect", cold.id]);
  for (const text of [
    "Plan: Pro",
    "Resets: 2026-10-09T17:00:00Z",
    "Runs out: 2026-10-09T16:00:00Z",
    "Shortfall: 4.25%",
    "Tier: Enterprise",
  ])
    assert.ok(detail.includes(text), text);
  const refreshed = JSON.parse(await ok(["usage", "inspect", cold.id, "--refresh", "--json"]));
  assert.equal(refreshed.report.windows[0].usedPct, 2);
  const personal = JSON.parse(await ok(["usage", "inspect", "cli-usage:personal", "--json"]));
  assert.equal(personal.report.windows[0].usedPct, 1);
  const allRefreshed = JSON.parse(await ok(["usage", "ls", "--refresh", "--json"]));
  assert.equal(
    allRefreshed.find((entry: { id: string }) => entry.id === cold.id).report.windows[0].usedPct,
    3,
  );
  for (const id of ["cli-usage:work", "missing"]) {
    const unknown = await context.paseo(["usage", "inspect", id, "--json"]);
    assert.equal(unknown.exitCode, 1);
    assert.equal(unknown.stdout, "");
    assert.equal(JSON.parse(unknown.stderr).error.code, "REPORT_NOT_FOUND");
  }
  const agentFailure = await context.paseo(["usage", "ls", "--agent", "missing-agent", "--json"]);
  assert.equal(agentFailure.exitCode, 1);
  assert.equal(agentFailure.stdout, "");
  assert.match(JSON.parse(agentFailure.stderr).error.message, /Unknown agent/);
  const remove = await context.paseo(["plugin", "remove", "cli-usage", "--json"]);
  assert.equal(remove.exitCode, 0, remove.stderr);
  assert.equal((await ok(["usage", "ls", "--json"])).trim(), "[]");
  assert.equal((await ok(["usage"])).trim(), "No usage reports returned");
  const connection = await context.paseo(["usage", "ls", "--host", "127.0.0.1:1", "--json"]);
  assert.equal(connection.exitCode, 1);
  assert.equal(connection.stdout, "");
  assert.equal(JSON.parse(connection.stderr).error.code, "DAEMON_UNREACHABLE");
  console.log(
    "Usage CLI: cold inspect, default/ls, complete JSON, mixed statuses, all windows/balances, inspect details, refresh, IDs, errors and empty discovery passed.",
  );
} finally {
  await context.stop();
}
