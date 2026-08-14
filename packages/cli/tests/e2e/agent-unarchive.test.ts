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

interface ListedAgent {
  id: string;
}

interface UnarchiveOutput {
  agentId: string;
  status: string;
  timelineSize: number;
}

function expectSuccess(result: Awaited<ReturnType<E2EContext["paseo"]>>, command: string): void {
  assert.strictEqual(
    result.exitCode,
    0,
    `${command} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

async function main(): Promise<void> {
  let ctx: E2EContext | undefined;

  try {
    ctx = await createE2ETestContext({
      timeout: 45_000,
      env: { PASEO_NODE_ENV: "development" },
    });

    const run = await ctx.paseo([
      "--quiet",
      "run",
      "--background",
      "--provider",
      "mock",
      "--model",
      "ten-second-stream",
      "--mode",
      "load-test",
      "Create an agent for the unarchive end-to-end test",
    ]);
    expectSuccess(run, "paseo run");
    const agentId = run.stdout.trim();
    assert.match(agentId, /^[0-9a-f-]{36}$/i, "run should return the created agent ID");

    const archive = await ctx.paseo(["--json", "archive", "--force", agentId]);
    expectSuccess(archive, "paseo archive");

    const activeAfterArchive = await ctx.paseo(["--json", "ls", "--global"]);
    expectSuccess(activeAfterArchive, "paseo ls --global");
    assert(
      !(JSON.parse(activeAfterArchive.stdout) as ListedAgent[]).some(
        (agent) => agent.id === agentId,
      ),
      "archived agent should be absent from the default list",
    );

    const unarchive = await ctx.paseo(["--json", "agent", "unarchive", agentId]);
    expectSuccess(unarchive, "paseo agent unarchive");
    const unarchiveOutput = JSON.parse(unarchive.stdout) as UnarchiveOutput;
    assert.strictEqual(unarchiveOutput.agentId, agentId);
    assert.strictEqual(unarchiveOutput.status, "unarchived");
    assert(
      Number.isInteger(unarchiveOutput.timelineSize) && unarchiveOutput.timelineSize >= 0,
      "unarchive should report the reloaded timeline size",
    );

    const activeAfterUnarchive = await ctx.paseo(["--json", "ls", "--global"]);
    expectSuccess(activeAfterUnarchive, "paseo ls --global");
    assert(
      (JSON.parse(activeAfterUnarchive.stdout) as ListedAgent[]).some(
        (agent) => agent.id === agentId,
      ),
      "unarchived agent should return to the default list",
    );
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    await ctx?.stop();
  }
}

void main();
