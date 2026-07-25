import { afterEach, expect, test } from "vitest";
import {
  HubRelationshipHarness,
  SetupFailingArchiveWatchFiles,
} from "./test-utils/relationship-harness.js";

let relationship: HubRelationshipHarness | null = null;

afterEach(async () => {
  await relationship?.close();
  relationship = null;
});

async function launchRelationship(): Promise<HubRelationshipHarness> {
  const launched = await HubRelationshipHarness.start();
  await launched.beginConnect().result;
  launched.connectLatestSocket();
  relationship = launched;
  return launched;
}

test("Hub retries one durable daemon execution across concurrency and reconstruction", async () => {
  const hub = await launchRelationship();

  const created = await hub.createOwnedConcurrently();
  const update = await hub.ownedUpdate(created.first.agentId);
  const stream = await hub.ownedStream(created.first.agentId);
  const reconstructed = await hub.reconstructAndReplay();

  expect(created.duplicate.agentId).toBe(created.first.agentId);
  expect(update).toMatchObject({
    executionId: "execution-1",
    agentId: created.first.agentId,
    agent: { id: created.first.agentId },
  });
  expect(stream).toMatchObject({ executionId: "execution-1", agentId: created.first.agentId });
  expect(reconstructed.replay.agent.id).toBe(created.first.agentId);
  expect(reconstructed.durableAgentCount).toBe(1);
});

test("Hub denies trusted steering and browser dispatch", async () => {
  const hub = await launchRelationship();
  const localAgentId = await hub.createUnrelatedLocalAgent();

  const steeringDenial = await hub.deniedSteering(localAgentId);
  const browserDenial = await hub.deniedBrowserDispatch();

  expect(steeringDenial).toEqual({
    requestId: "denied-steer",
    requestType: "send_agent_message_request",
    error: "Session is not authorized for send_agent_message_request",
    code: "access_denied",
  });
  expect(browserDenial).toEqual({
    requestId: "browser-1",
    requestType: "browser.automation.execute.response",
    error: "Session is not authorized for browser.automation.execute.response",
    code: "access_denied",
  });
  expect(hub.observedAgentIds()).not.toContain(localAgentId);
  expect(hub.observedTrustedLifecycleMessages()).toEqual([]);
});

test("Hub sockets reject trusted hello and capabilities", async () => {
  const hub = await launchRelationship();

  expect(hub.probeTrustedHello()).toBe(4002);
});

test("Hub sockets reject trusted binary frames", async () => {
  const hub = await launchRelationship();

  expect(hub.probeBinaryFrame()).toBe(4002);
});

test("Hub does not receive trusted broadcasts", async () => {
  const hub = await launchRelationship();

  const trustedBroadcasts = await hub.trustedBroadcastCount();
  const trustedStatus = await hub.trustedDaemonStatus();

  expect(trustedBroadcasts).toBe(0);
  expect(trustedStatus).toMatchObject({ pid: process.pid, relay: { enabled: false } });
  expect(hub.observedTrustedLifecycleMessages()).toEqual([]);
});

test("Hub reconnects without retaining trusted session state", async () => {
  const hub = await launchRelationship();
  const created = await hub.createOwnedConcurrently();

  const reconnected = await hub.reconnectAndRetry();

  expect(reconnected).toMatchObject({
    executionId: "execution-1",
    agentId: created.first.agentId,
  });
  expect(hub.observedTrustedLifecycleMessages()).toEqual([]);
});

test("Hub interrupts an owned running execution idempotently", async () => {
  const hub = await launchRelationship();
  hub.beginOwnedCreate("interrupt-create", "execution-interrupt", { prompt: "sleep 30" });
  const created = await hub.ownedCreateResult("interrupt-create");
  await hub.ownedRunningUpdate(created.payload.agentId!);

  const interrupted = await hub.interruptExecution("execution-interrupt", "interrupt-first");
  const duplicate = await hub.interruptExecution("execution-interrupt", "interrupt-duplicate");

  expect(interrupted).toEqual({
    requestId: "interrupt-first",
    executionId: "execution-interrupt",
    action: "interrupt",
    success: true,
    error: null,
  });
  expect(duplicate).toEqual({
    requestId: "interrupt-duplicate",
    executionId: "execution-interrupt",
    action: "interrupt",
    success: true,
    error: null,
  });
  expect(hub.ownedAgentIsRunning(created.payload.agentId!)).toBe(false);
});

test("Hub control waits for an in-flight create of the same execution", async () => {
  const hub = await launchRelationship();
  hub.holdAgentCreation();
  hub.beginOwnedCreate("pending-control-create", "execution-pending-control", {
    prompt: "sleep 30",
  });
  await hub.agentCreationAttempts(1);

  hub.beginExecutionControl("pending-control-archive", "execution-pending-control", "archive");
  hub.finishAgentCreation();
  const created = await hub.ownedCreateResult("pending-control-create");
  const archived = await hub.executionControlResult("pending-control-archive");

  expect(created).toMatchObject({ payload: { success: true, agentId: expect.any(String) } });
  expect(archived).toMatchObject({ success: true, error: null, action: "archive" });
  expect(await hub.ownedAgentArchivedAt(created.payload.agentId!)).toEqual(expect.any(String));
}, 20_000);

test("Hub archives only the owned agent in a shared local checkout", async () => {
  const hub = await launchRelationship();
  hub.beginOwnedCreate("local-create", "execution-local", { prompt: "sleep 30" });
  const created = await hub.ownedCreateResult("local-create");
  await hub.ownedRunningUpdate(created.payload.agentId!);

  const archived = await hub.archiveExecution("execution-local", "archive-local");
  const duplicate = await hub.archiveExecution("execution-local", "archive-local-duplicate");

  expect(archived).toMatchObject({ success: true, error: null, action: "archive" });
  expect(duplicate).toMatchObject({ success: true, error: null, action: "archive" });
  expect(await hub.ownedAgentArchivedAt(created.payload.agentId!)).toEqual(expect.any(String));
  expect(hub.ownedAgentIsRunning(created.payload.agentId!)).toBe(false);
  expect(hub.repoExists()).toBe(true);
});

test("Hub archives a running execution's Paseo-created worktree", async () => {
  const hub = await launchRelationship();
  hub.beginOwnedCreate("worktree-create", "execution-worktree", {
    worktree: { mode: "branch-off", newBranch: "hub-created-worktree", base: "main" },
    prompt: "sleep 30",
  });
  const worktreeCreated = await hub.ownedCreateResult("worktree-create");
  const worktreeCwd = hub.latestCreatedCwd();
  await hub.ownedRunningUpdate(worktreeCreated.payload.agentId!);
  const duringRun = await hub.worktreeState(worktreeCwd!);
  const archiveCompletion = hub.waitForOwnedArchiveCompletion(worktreeCreated.payload.agentId!);
  const response = await hub.archiveExecution("execution-worktree", "archive-worktree");
  const archive = await archiveCompletion;
  const afterArchive = await hub.worktreeState(worktreeCwd!);

  expect(worktreeCreated).toMatchObject({
    type: "hub.execution.agent.create.response",
    payload: { success: true, agent: { cwd: worktreeCwd } },
  });
  expect(worktreeCwd).not.toBe(hub.repoRoot());
  expect(duringRun).toEqual({ exists: true, listed: true });
  expect(response).toMatchObject({ success: true, error: null, action: "archive" });
  expect(afterArchive).toEqual({ exists: false, listed: false });
  expect(archive).toEqual({
    agentArchivedAt: expect.any(String),
    workspaceArchivedAt: expect.any(String),
  });
}, 20_000);

test("a sibling workspace keeps an archived execution's worktree directory alive", async () => {
  const hub = await launchRelationship();
  hub.beginOwnedCreate("sibling-create", "execution-sibling", {
    worktree: { mode: "branch-off", newBranch: "hub-sibling-worktree", base: "main" },
    prompt: "sleep 30",
  });
  const created = await hub.ownedCreateResult("sibling-create");
  const worktreeCwd = hub.latestCreatedCwd()!;
  await hub.ownedRunningUpdate(created.payload.agentId!);
  await hub.createSiblingWorkspace(worktreeCwd);

  const response = await hub.archiveExecution("execution-sibling", "archive-sibling");

  expect(response).toMatchObject({ success: true, error: null });
  expect(await hub.worktreeState(worktreeCwd)).toEqual({ exists: true, listed: true });
  expect(await hub.ownedAgentArchivedAt(created.payload.agentId!)).toEqual(expect.any(String));
}, 20_000);

test("archiving an execution in a reused worktree leaves the existing workspace intact", async () => {
  const hub = await launchRelationship();
  const worktree = {
    mode: "branch-off" as const,
    newBranch: "hub-reused-worktree",
    base: "main",
  };
  hub.beginOwnedCreate("original-worktree-create", "execution-original-worktree", {
    worktree,
    prompt: "respond with exactly: original complete",
  });
  const original = await hub.ownedCreateResult("original-worktree-create");
  const worktreeCwd = hub.latestCreatedCwd()!;
  await hub.ownedTurnCompletion(original.payload.agentId!);

  hub.beginOwnedCreate("reused-worktree-create", "execution-reused-worktree", {
    worktree,
    prompt: "sleep 30",
  });
  const reused = await hub.ownedCreateResult("reused-worktree-create");
  await hub.ownedRunningUpdate(reused.payload.agentId!);

  const response = await hub.archiveExecution(
    "execution-reused-worktree",
    "archive-reused-worktree",
  );

  expect(response).toMatchObject({ success: true, error: null });
  expect(hub.pathsReferToSameLocation(reused.payload.agent!.cwd, worktreeCwd)).toBe(true);
  expect(await hub.worktreeState(worktreeCwd)).toEqual({ exists: true, listed: true });
  expect(await hub.agentRemainsAvailable(original.payload.agentId!)).toBe(true);
  expect(await hub.ownedAgentArchivedAt(reused.payload.agentId!)).toEqual(expect.any(String));
}, 20_000);

test("Hub resolves persisted execution ownership after daemon restart", async () => {
  const hub = await launchRelationship();
  hub.beginOwnedCreate("restart-create", "execution-restart", {
    worktree: { mode: "branch-off", newBranch: "hub-restart-worktree", base: "main" },
    prompt: "sleep 30",
  });
  const created = await hub.ownedCreateResult("restart-create");
  const worktreeCwd = hub.latestCreatedCwd()!;
  await hub.ownedRunningUpdate(created.payload.agentId!);

  await hub.restartDaemon();
  await hub.socketDialed();
  hub.connectLatestSocket();
  const response = await hub.archiveExecution("execution-restart", "archive-after-restart");

  expect(response).toMatchObject({ success: true, error: null });
  expect(await hub.ownedAgentArchivedAt(created.payload.agentId!)).toEqual(expect.any(String));
  expect(await hub.worktreeState(worktreeCwd)).toEqual({ exists: false, listed: false });
}, 20_000);

test("Hub treats missing and foreign executions as already controlled without exposing ownership", async () => {
  const hub = await launchRelationship();
  const foreignAgentId = await hub.createForeignExecution("execution-foreign");

  const missingInterrupt = await hub.interruptExecution("execution-missing", "interrupt-missing");
  const missingArchive = await hub.archiveExecution("execution-missing", "archive-missing");
  const foreignInterrupt = await hub.interruptExecution("execution-foreign", "interrupt-foreign");
  const foreignArchive = await hub.archiveExecution("execution-foreign", "archive-foreign");

  expect([missingInterrupt, missingArchive, foreignInterrupt, foreignArchive]).toEqual([
    expect.objectContaining({ success: true, error: null }),
    expect.objectContaining({ success: true, error: null }),
    expect.objectContaining({ success: true, error: null }),
    expect.objectContaining({ success: true, error: null }),
  ]);
  expect(await hub.agentRemainsAvailable(foreignAgentId)).toBe(true);
});

test("archive observation closes its first watcher when the second watcher cannot start", async () => {
  const watchFiles = new SetupFailingArchiveWatchFiles(2);
  const hub = await HubRelationshipHarness.start(watchFiles);
  relationship = hub;
  await hub.beginConnect().result;
  hub.connectLatestSocket();
  hub.beginOwnedCreate("watch-setup-create", "watch-setup-execution");
  const created = await hub.ownedCreateResult("watch-setup-create");

  await expect(hub.waitForOwnedArchiveCompletion(created.payload.agentId!)).rejects.toThrow(
    "Cannot watch",
  );

  expect(watchFiles.activeDirectories()).toEqual([]);
});
