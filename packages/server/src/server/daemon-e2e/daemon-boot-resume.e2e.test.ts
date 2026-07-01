import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-boot-resume-"));
}

interface StoredRecordOnDisk {
  filePath: string;
  record: {
    id: string;
    lastStatus: string;
    interruptedAt?: string | null;
    persistence?: unknown;
  };
}

function findStoredRecord(paseoHome: string, agentId: string): StoredRecordOnDisk {
  const agentsRoot = path.join(paseoHome, "agents");
  for (const dir of readdirSync(agentsRoot, { withFileTypes: true })) {
    if (!dir.isDirectory()) {
      continue;
    }
    const filePath = path.join(agentsRoot, dir.name, `${agentId}.json`);
    try {
      const record = JSON.parse(readFileSync(filePath, "utf8")) as StoredRecordOnDisk["record"];
      return { filePath, record };
    } catch {
      // keep scanning other cwd directories
    }
  }
  throw new Error(`Stored record for agent ${agentId} not found under ${agentsRoot}`);
}

/**
 * Drives a fake Codex agent into a running state (blocked on a pending
 * permission) so the daemon shuts down while the agent is mid-turn.
 */
async function createAgentRunningAtShutdown(
  ctx: DaemonTestContext,
  cwd: string,
  marker: string,
): Promise<string> {
  const agent = await ctx.client.createAgent({
    provider: "codex",
    cwd,
    title: "Boot Resume Test Agent",
    modeId: "read-only",
  });

  await ctx.client.sendMessage(agent.id, `Remember this marker string for a test: "${marker}".`);
  const afterRemember = await ctx.client.waitForFinish(agent.id, 5_000);
  expect(afterRemember.status).toBe("idle");
  expect(afterRemember.final?.persistence).toBeTruthy();

  await ctx.client.sendMessage(
    agent.id,
    'Request approval to run the command `printf "ok" > permission.txt`.',
  );
  const pendingState = await ctx.client.waitForFinish(agent.id, 5_000);
  expect(pendingState.final?.pendingPermissions?.length).toBeGreaterThan(0);

  return agent.id;
}

describe("daemon boot resume", () => {
  let ctx: DaemonTestContext | null = null;
  let paseoHomeRoot: string | null = null;

  afterEach(async () => {
    await ctx?.cleanup();
    ctx = null;
    if (paseoHomeRoot) {
      rmSync(paseoHomeRoot, { recursive: true, force: true });
      paseoHomeRoot = null;
    }
  }, 60_000);

  test("graceful shutdown marks mid-run agents and boot resumes them when enabled", async () => {
    const cwd = tmpCwd();
    const marker = `BOOT_RESUME_MARKER_${Date.now()}`;
    paseoHomeRoot = await mkdtemp(path.join(tmpdir(), "paseo-home-boot-resume-"));
    try {
      ctx = await createDaemonTestContext({ paseoHomeRoot, cleanup: false });
      const paseoHome = ctx.daemon.paseoHome;
      const agentId = await createAgentRunningAtShutdown(ctx, cwd, marker);

      await ctx.cleanup();
      ctx = null;

      const stored = findStoredRecord(paseoHome, agentId);
      expect(stored.record.lastStatus).toBe("closed");
      expect(stored.record.interruptedAt).toBeTruthy();
      expect(stored.record.persistence).toBeTruthy();

      ctx = await createDaemonTestContext({
        paseoHomeRoot,
        cleanup: false,
        resumeAgentsOnBoot: true,
      });

      // Resumed during boot — present in the manager without any resume RPC.
      expect(ctx.daemon.daemon.agentManager.getAgent(agentId)).toBeTruthy();

      // The marker self-clears once the resumed agent persists a snapshot.
      await ctx.client.sendMessage(
        agentId,
        "What was the marker string I asked you to remember earlier?",
      );
      const afterRecall = await ctx.client.waitForFinish(agentId, 5_000);
      expect(afterRecall.status).toBe("idle");
      expect(afterRecall.final!.persistence!.metadata).toMatchObject({ marker });

      const afterResume = findStoredRecord(paseoHome, agentId);
      expect(afterResume.record.interruptedAt ?? null).toBeNull();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 30_000);

  test("boot does not resume interrupted agents when the flag is off", async () => {
    const cwd = tmpCwd();
    const marker = `BOOT_RESUME_OFF_MARKER_${Date.now()}`;
    paseoHomeRoot = await mkdtemp(path.join(tmpdir(), "paseo-home-boot-resume-off-"));
    try {
      ctx = await createDaemonTestContext({ paseoHomeRoot, cleanup: false });
      const paseoHome = ctx.daemon.paseoHome;
      const agentId = await createAgentRunningAtShutdown(ctx, cwd, marker);

      await ctx.cleanup();
      ctx = null;

      expect(findStoredRecord(paseoHome, agentId).record.interruptedAt).toBeTruthy();

      ctx = await createDaemonTestContext({ paseoHomeRoot, cleanup: false });

      expect(ctx.daemon.daemon.agentManager.getAgent(agentId)).toBeNull();
      expect(findStoredRecord(paseoHome, agentId).record.interruptedAt).toBeTruthy();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 30_000);

  test("boot resumes agents left with a running status by an unclean shutdown", async () => {
    const cwd = tmpCwd();
    const marker = `BOOT_RESUME_CRASH_MARKER_${Date.now()}`;
    paseoHomeRoot = await mkdtemp(path.join(tmpdir(), "paseo-home-boot-resume-crash-"));
    try {
      ctx = await createDaemonTestContext({ paseoHomeRoot, cleanup: false });
      const paseoHome = ctx.daemon.paseoHome;

      const agent = await ctx.client.createAgent({
        provider: "codex",
        cwd,
        title: "Boot Resume Crash Test Agent",
        modeId: "read-only",
      });
      await ctx.client.sendMessage(
        agent.id,
        `Remember this marker string for a test: "${marker}".`,
      );
      const afterRemember = await ctx.client.waitForFinish(agent.id, 5_000);
      expect(afterRemember.status).toBe("idle");
      expect(afterRemember.final?.persistence).toBeTruthy();

      await ctx.cleanup();
      ctx = null;

      // Simulate a crash: an unclean exit never runs the graceful close pass,
      // so the record keeps its live status and gets no interruptedAt marker.
      const stored = findStoredRecord(paseoHome, agent.id);
      writeFileSync(
        stored.filePath,
        JSON.stringify({ ...stored.record, lastStatus: "running", interruptedAt: null }),
      );

      ctx = await createDaemonTestContext({
        paseoHomeRoot,
        cleanup: false,
        resumeAgentsOnBoot: true,
      });

      expect(ctx.daemon.daemon.agentManager.getAgent(agent.id)).toBeTruthy();

      await ctx.client.sendMessage(
        agent.id,
        "What was the marker string I asked you to remember earlier?",
      );
      const afterRecall = await ctx.client.waitForFinish(agent.id, 5_000);
      expect(afterRecall.status).toBe("idle");
      expect(afterRecall.final!.persistence!.metadata).toMatchObject({ marker });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 30_000);
});
