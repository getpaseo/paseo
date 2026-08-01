import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { DaemonClient } from "./test-utils/index.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "./test-utils/paseo-daemon.js";

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
      reason: "Timeline history is unavailable.",
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

test("fetch agent does not inherit a previous stall after a new turn is accepted", async () => {
  const daemon = await createTestPaseoDaemon();
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.2.5",
  });
  const cwd = mkdtempSync(path.join(tmpdir(), "paseo-material-progress-boundary-"));
  let agentId: string | null = null;

  try {
    await client.connect();
    const created = await client.createAgent({
      provider: "codex",
      cwd,
      title: "Accepted continuation boundary probe",
      modeId: "default",
      model: "gpt-5.4-mini",
    });
    agentId = created.id;
    await daemon.daemon.agentManager.appendTimelineItem(created.id, {
      type: "user_message",
      text: "previous continuation",
    });
    await daemon.daemon.agentManager.appendTimelineItem(created.id, {
      type: "compaction",
      status: "completed",
    });
    await daemon.daemon.agentManager.appendTimelineItem(created.id, {
      type: "compaction",
      status: "completed",
    });

    expect(
      (await client.fetchAgent({ agentId: created.id }))?.agent.materialProgress,
    ).toMatchObject({
      state: "stalled",
      completedCompactionsSinceMaterialProgress: 2,
    });

    // The fake provider stops at a permission request after accepting the turn. It intentionally
    // emits no user_message row, reproducing providers that acknowledge a continuation before
    // (or without) projecting the prompt into timeline history.
    await client.sendMessage(created.id, "read /etc/hosts");
    await expect
      .poll(async () => (await client.fetchAgent({ agentId: created.id }))?.agent.status ?? null, {
        timeout: 10_000,
        interval: 25,
      })
      .toBe("running");

    const fetched = await client.fetchAgent({ agentId: created.id });
    expect(fetched?.agent.materialProgress).toEqual({
      state: "none",
      completedCompactionsSinceMaterialProgress: 0,
      lastMaterialProgressAt: null,
      lastMaterialProgressKind: null,
      reason: "No material progress has been recorded for the current continuation.",
    });
    expect(
      (await daemon.daemon.agentManager.getMaterialProgressSnapshot(created.id)).rows,
    ).toHaveLength(3);
  } finally {
    if (agentId) await client.cancelAgent(agentId).catch(() => undefined);
    await client.close();
    await daemon.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("fetch agent does not inherit a previous stall when an accepted turn fails before a user row", async () => {
  const daemon = await createTestPaseoDaemon();
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.2.5",
  });
  const cwd = mkdtempSync(path.join(tmpdir(), "paseo-material-progress-failed-boundary-"));

  try {
    await client.connect();
    const created = await client.createAgent({
      provider: "codex",
      cwd,
      title: "Failed continuation boundary probe",
      modeId: "full-access",
      model: "gpt-5.4-mini",
    });
    await daemon.daemon.agentManager.appendTimelineItem(created.id, {
      type: "user_message",
      text: "previous continuation",
    });
    await daemon.daemon.agentManager.appendTimelineItem(created.id, {
      type: "compaction",
      status: "completed",
    });
    await daemon.daemon.agentManager.appendTimelineItem(created.id, {
      type: "compaction",
      status: "completed",
    });
    expect(
      (await client.fetchAgent({ agentId: created.id }))?.agent.materialProgress,
    ).toMatchObject({ state: "stalled" });

    // The fake provider emits turn_started followed by turn_failed, without a user_message row.
    await client.sendMessage(created.id, "emit a turn failure");
    await expect
      .poll(async () => (await client.fetchAgent({ agentId: created.id }))?.agent.status ?? null, {
        timeout: 10_000,
        interval: 25,
      })
      .toBe("error");

    const snapshot = await daemon.daemon.agentManager.getMaterialProgressSnapshot(created.id);
    expect(snapshot.turnOutcome).toBe("failed");
    expect(snapshot.continuationBoundarySeq).toBe(4);
    expect((await client.fetchAgent({ agentId: created.id }))?.agent.materialProgress).toEqual({
      state: "none",
      completedCompactionsSinceMaterialProgress: 0,
      lastMaterialProgressAt: null,
      lastMaterialProgressKind: null,
      reason: "No material progress has been recorded for the current continuation.",
    });
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
