#!/usr/bin/env npx tsx

import assert from "node:assert";
import { createE2ETestContext, type TestDaemonContext } from "../helpers/test-daemon.ts";

interface E2EContext extends TestDaemonContext {
  paseo: (
    args: string[],
    opts?: { timeout?: number; cwd?: string },
  ) => Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
}

let ctx: E2EContext;

async function setup(): Promise<void> {
  ctx = await createE2ETestContext({ timeout: 45_000 });
}

async function cleanup(): Promise<void> {
  if (ctx) {
    await ctx.stop();
  }
}

async function test_invalid_opencode_model_does_not_report_completed_while_still_running() {
  const result = await ctx.paseo(["run", "--provider", "opencode/adklasldkdas", "hello"], {
    timeout: 45_000,
  });

  const output = `${result.stdout}\n${result.stderr}`;
  const agentId = output.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  )?.[0];

  if (result.exitCode !== 0) {
    assert(
      output.toLowerCase().includes("error") || output.toLowerCase().includes("failed"),
      `expected invalid model failure output\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    return;
  }

  assert(agentId, `expected run output to include an agent id\nstdout:\n${result.stdout}`);

  const inspect = await ctx.paseo(["inspect", agentId], { timeout: 15_000 });
  assert.strictEqual(
    inspect.exitCode,
    0,
    `inspect failed\nstdout:\n${inspect.stdout}\nstderr:\n${inspect.stderr}`,
  );

  const runReportedCompleted = result.stdout.includes("completed");
  const inspectStillRunning = inspect.stdout.includes("Status              running");

  assert(
    !(runReportedCompleted && inspectStillRunning),
    `run reported completed while inspect still showed running\nrun stdout:\n${result.stdout}\ninspect stdout:\n${inspect.stdout}`,
  );
}

async function main(): Promise<void> {
  try {
    await setup();
    await test_invalid_opencode_model_does_not_report_completed_while_still_running();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    await cleanup();
  }
}

main();
