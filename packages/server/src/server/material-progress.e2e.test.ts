import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { DaemonClient } from "./test-utils/index.js";
import {
  createTestPaseoDaemon,
  type TestPaseoDaemon,
} from "./test-utils/paseo-daemon.js";

async function recordMaterialWrite(daemon: TestPaseoDaemon, agentId: string): Promise<void> {
  await daemon.daemon.agentManager.appendTimelineItem(agentId, {
    type: "user_message",
    text: "implement",
  });
  await daemon.daemon.agentManager.appendTimelineItem(agentId, {
    type: "compaction",
    status: "completed",
  });
  await daemon.daemon.agentManager.appendTimelineItem(agentId, {
    type: "tool_call",
    callId: "write-1",
    name: "write",
    status: "completed",
    error: null,
    detail: { type: "write", filePath: "proof.txt", content: "done" },
  });
}

function expectMaterialWriteProgress(
  materialProgress: NonNullable<
    Awaited<ReturnType<DaemonClient["fetchAgent"]>>
  >["agent"]["materialProgress"],
): void {
  expect(materialProgress).toMatchObject({
    state: "progressing",
    completedCompactionsSinceMaterialProgress: 0,
    lastMaterialProgressKind: "write",
  });
}

test("fetch agent exposes a backward-compatible material progress signal", async () => {
  const daemon = await createTestPaseoDaemon();
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.2.5",
  });
  const cwd = mkdtempSync(path.join(tmpdir(), "paseo-material-progress-"));

  try {
    await client.connect();
    const created = await client.createAgent({
      provider: "codex",
      cwd,
      title: "Material progress probe",
      modeId: "full-access",
      model: "gpt-5.4-mini",
    });
    const fetched = await client.fetchAgent({ agentId: created.id });

    expect(fetched?.agent.materialProgress).toEqual({
      state: "none",
      completedCompactionsSinceMaterialProgress: 0,
      lastMaterialProgressAt: null,
      lastMaterialProgressKind: null,
      reason: "No current continuation is available.",
    });
  } finally {
    await client.close();
    await daemon.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("fetch agent preserves material progress after the live worker is collected", async () => {
  const daemon = await createTestPaseoDaemon();
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.2.5",
  });
  const cwd = mkdtempSync(path.join(tmpdir(), "paseo-material-progress-retained-"));

  try {
    await client.connect();
    const created = await client.createAgent({
      provider: "codex",
      cwd,
      title: "Retained material progress probe",
      modeId: "full-access",
      model: "gpt-5.4-mini",
    });
    await recordMaterialWrite(daemon, created.id);
    await daemon.daemon.agentManager.closeAgent(created.id);

    const fetched = await client.fetchAgent({ agentId: created.id });
    expectMaterialWriteProgress(fetched?.agent.materialProgress);
  } finally {
    await client.close();
    await daemon.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("fetch agent preserves material progress after archive discards the live timeline", async () => {
  const daemon = await createTestPaseoDaemon();
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.2.5",
  });
  const cwd = mkdtempSync(path.join(tmpdir(), "paseo-material-progress-archived-"));

  try {
    await client.connect();
    const created = await client.createAgent({
      provider: "codex",
      cwd,
      title: "Archived material progress probe",
      modeId: "full-access",
      model: "gpt-5.4-mini",
    });
    await recordMaterialWrite(daemon, created.id);
    await client.archiveAgent(created.id);

    const fetched = await client.fetchAgent({ agentId: created.id });
    expect(fetched?.agent.archivedAt).toEqual(expect.any(String));
    expectMaterialWriteProgress(fetched?.agent.materialProgress);
  } finally {
    await client.close();
    await daemon.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("fetch agent restores material progress after daemon restart", async () => {
  const paseoHomeRoot = mkdtempSync(path.join(tmpdir(), "paseo-material-progress-home-"));
  const staticDir = mkdtempSync(path.join(tmpdir(), "paseo-material-progress-static-"));
  const cwd = mkdtempSync(path.join(tmpdir(), "paseo-material-progress-restart-"));
  let daemon: TestPaseoDaemon | null = null;
  let client: DaemonClient | null = null;

  try {
    daemon = await createTestPaseoDaemon({
      paseoHomeRoot,
      staticDir,
      cleanup: false,
    });
    client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      appVersion: "0.2.5",
    });
    await client.connect();
    const created = await client.createAgent({
      provider: "codex",
      cwd,
      title: "Restarted material progress probe",
      modeId: "full-access",
      model: "gpt-5.4-mini",
    });
    await recordMaterialWrite(daemon, created.id);

    await client.close();
    client = null;
    await daemon.close();
    daemon = null;

    daemon = await createTestPaseoDaemon({
      paseoHomeRoot,
      staticDir,
      cleanup: false,
    });
    client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      appVersion: "0.2.5",
    });
    await client.connect();

    const fetched = await client.fetchAgent({ agentId: created.id });
    expectMaterialWriteProgress(fetched?.agent.materialProgress);
  } finally {
    await client?.close().catch(() => undefined);
    await daemon?.close().catch(() => undefined);
    rmSync(cwd, { recursive: true, force: true });
    rmSync(paseoHomeRoot, { recursive: true, force: true });
    rmSync(staticDir, { recursive: true, force: true });
  }
});
