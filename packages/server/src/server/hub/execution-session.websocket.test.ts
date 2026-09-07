import { afterEach, expect, test } from "vitest";
import { HubRelationshipHarness } from "./test-utils/relationship-harness.js";

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

test("Hub execute can steer ordinary agents while unrelated administration stays denied", async () => {
  const hub = await launchRelationship();
  const agentId = await hub.createUnrelatedLocalAgent();
  const response = await hub.requestOrdinary({
    type: "send_agent_message_request",
    requestId: "ordinary-steer",
    agentId,
    text: "hello",
    messageId: "first-arrival",
    activeTurnBehavior: "steer",
  });
  expect(response).toMatchObject({
    type: "send_agent_message_response",
    payload: { accepted: true },
  });
  expect(await hub.deniedBrowserDispatch()).toMatchObject({ code: "access_denied" });
  expect(hub.serverInfoPermissions()).toEqual([["hub.execute"]]);
});

test("ordinary Hub create and message retries do not duplicate agents or prompts", async () => {
  const hub = await launchRelationship();
  const create = {
    type: "create_agent_request",
    idempotencyKey: "ordinary-create",
    config: { provider: "codex", cwd: hub.repoRoot() },
  };
  const responses = await Promise.all([
    hub.requestOrdinary({ ...create, requestId: "create-first" }),
    hub.requestOrdinary({ ...create, requestId: "create-duplicate" }),
  ]);
  const first = responses[0];
  expect(first).toMatchObject({ type: "status", payload: { status: "agent_created" } });
  if (first?.type !== "status" || first.payload.status !== "agent_created")
    throw new Error("Agent was not created");
  const agentId = first.payload.agentId;
  expect(responses[1]).toMatchObject({ type: "status", payload: { agentId } });
  expect(
    await hub.requestOrdinary({
      type: "fetch_agents_request",
      requestId: "observe-agents",
      subscribe: { subscriptionId: "hub-agents" },
    }),
  ).toMatchObject({ type: "fetch_agents_response" });
  expect(
    await hub.requestOrdinary({
      type: "agent.timeline.set_subscription.request",
      requestId: "observe-timeline",
      agentIds: [agentId],
    }),
  ).toMatchObject({ type: "agent.timeline.set_subscription.response" });
  const message = {
    type: "send_agent_message_request",
    agentId,
    messageId: "ordinary-arrival",
    text: "hello",
    activeTurnBehavior: "steer",
  };
  expect(await hub.requestOrdinary({ ...message, requestId: "message-first" })).toMatchObject({
    payload: { accepted: true },
  });
  expect(await hub.requestOrdinary({ ...message, requestId: "message-duplicate" })).toMatchObject({
    payload: { accepted: true },
  });
  expect(
    hub
      .hubMessages()
      .some((event) => event.type === "agent_stream" && event.payload.agentId === agentId),
  ).toBe(true);
  expect(hub.providerPromptTexts().filter((text) => text === "hello")).toHaveLength(1);
  expect(
    await hub.requestOrdinary({ ...message, text: "changed", requestId: "message-conflict" }),
  ).toMatchObject({ payload: { accepted: false } });
});

test("ordinary Hub requests survive daemon restart and restore an archived workspace", async () => {
  const hub = await launchRelationship();
  const create = {
    type: "create_agent_request",
    idempotencyKey: "restorable-agent",
    config: { provider: "codex", cwd: hub.repoRoot() },
    worktree: { mode: "branch-off", newBranch: "ordinary-restoration" },
  };
  const response = await hub.requestOrdinary({ ...create, requestId: "restorable-create" });
  if (response.type !== "status" || response.payload.status !== "agent_created")
    throw new Error("Agent was not created");
  const { agentId, agent } = response.payload;
  if (!agent?.workspaceId) throw new Error("Workspace was not created");
  const workspaceId = agent.workspaceId;
  const message = {
    type: "send_agent_message_request",
    agentId,
    messageId: "before-restart",
    text: "hello",
    activeTurnBehavior: "steer",
  };
  expect(await hub.requestOrdinary({ ...message, requestId: "before-restart-send" })).toMatchObject(
    { payload: { accepted: true } },
  );
  await hub.restartDaemon();
  await hub.socketDialed();
  hub.connectLatestSocket();
  expect(await hub.requestOrdinary({ ...create, requestId: "replayed-create" })).toMatchObject({
    payload: { agentId },
  });
  expect(await hub.requestOrdinary({ ...message, requestId: "replayed-send" })).toMatchObject({
    payload: { accepted: true },
  });
  expect(hub.providerPromptTexts().filter((text) => text === "hello")).toHaveLength(1);
  expect(
    await hub.requestOrdinary({
      type: "archive_workspace_request",
      workspaceId,
      requestId: "ordinary-archive",
    }),
  ).toMatchObject({ payload: { error: null, archivedAt: expect.any(String) } });
  expect((await hub.worktreeState(agent.cwd)).exists).toBe(false);
  expect(
    await hub.requestOrdinary({
      type: "workspace.recovery.inspect.request",
      workspaceId,
      requestId: "inspect-recovery",
    }),
  ).toMatchObject({ payload: { state: { kind: "recoverable" } } });
  expect(
    await hub.requestOrdinary({
      type: "workspace.recovery.restore.request",
      workspaceId,
      requestId: "restore-workspace",
    }),
  ).toMatchObject({ payload: { accepted: true } });
  expect((await hub.worktreeState(agent.cwd)).exists).toBe(true);
  expect(
    await hub.requestOrdinary({
      ...message,
      text: "follow up",
      messageId: "after-restore",
      requestId: "after-restore-send",
    }),
  ).toMatchObject({ payload: { agentId, accepted: true } });
  expect(hub.providerPromptTexts().filter((text) => text === "follow up")).toHaveLength(1);
}, 20_000);

test("Hub completes the standard hello before rejecting a second hello", async () => {
  const hub = await launchRelationship();

  expect(hub.serverInfoPermissions()).toEqual([["hub.execute"]]);
  expect(hub.probeTrustedHello()).toBe(4002);
});

test("legacy Hub wire behavior still enters the common Session bootstrap", async () => {
  const launched = await HubRelationshipHarness.start();
  await launched.beginConnect().result;
  launched.connectLatestLegacySocket();
  relationship = launched;

  expect(launched.observedTrustedLifecycleMessages()).toEqual(["server_info"]);
  expect(launched.serverInfoPermissions()).toEqual([["hub.execute"]]);
});

test("Hub binary frames enter the standard active-session path", async () => {
  const hub = await launchRelationship();

  expect(hub.probeBinaryFrame()).toBeNull();
});

test("Hub receives standard server info but not broadcasts outside its scope", async () => {
  const hub = await launchRelationship();

  const trustedBroadcasts = await hub.trustedBroadcastCount();
  const trustedStatus = await hub.trustedDaemonStatus();

  expect(trustedBroadcasts).toBe(0);
  expect(trustedStatus).toMatchObject({ pid: process.pid, relay: { enabled: false } });
  expect(hub.observedTrustedLifecycleMessages()).toEqual(["server_info"]);
});

test("Hub reconnects through the standard resumable session bootstrap", async () => {
  const hub = await launchRelationship();
  const created = await hub.createOwnedConcurrently();

  const reconnected = await hub.reconnectAndRetry();

  expect(reconnected).toMatchObject({
    executionId: "execution-1",
    agentId: created.first.agentId,
  });
  expect(hub.observedTrustedLifecycleMessages()).toEqual(["server_info", "server_info"]);
  expect(hub.serverInfoPermissions()).toEqual([["hub.execute"], ["hub.execute"]]);
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
  expect(created.payload.agent?.workspaceId).toEqual(expect.any(String));
  expect(await hub.ownedAgentArchivedAt(created.payload.agentId!)).toEqual(expect.any(String));
});

test("Hub archives an execution workspace on a local checkout", async () => {
  const hub = await launchRelationship();
  const siblingWorkspaceId = await hub.createSiblingWorkspace(hub.repoRoot());
  hub.beginOwnedCreate("local-create", "execution-local", {
    workspaceId: siblingWorkspaceId,
    prompt: "sleep 30",
  });
  const created = await hub.ownedCreateResult("local-create");
  const executionWorkspaceId = created.payload.agent?.workspaceId;
  expect(executionWorkspaceId).toEqual(expect.any(String));
  const terminalId = await hub.createWorkspaceTerminal(executionWorkspaceId!);
  await hub.ownedRunningUpdate(created.payload.agentId!);

  const archived = await hub.archiveExecution("execution-local", "archive-local");
  const duplicate = await hub.archiveExecution("execution-local", "archive-local-duplicate");

  expect(archived).toMatchObject({ success: true, error: null, action: "archive" });
  expect(duplicate).toMatchObject({ success: true, error: null, action: "archive" });
  expect(executionWorkspaceId).not.toBe(siblingWorkspaceId);
  expect(await hub.ownedAgentArchivedAt(created.payload.agentId!)).toEqual(expect.any(String));
  expect(await hub.ownedWorkspaceArchivedAt(created.payload.agentId!)).toEqual(expect.any(String));
  expect(await hub.archivedWorkspaceAt(siblingWorkspaceId)).toBeNull();
  expect(hub.terminalExists(terminalId)).toBe(false);
  expect(hub.ownedAgentIsRunning(created.payload.agentId!)).toBe(false);
  expect(hub.repoExists()).toBe(true);
});

test("Hub creates and archives distinct local workspaces for classifier and worker executions", async () => {
  const hub = await launchRelationship();
  hub.beginOwnedCreate("classifier-create", "execution-classifier", {
    prompt: "Classify the request",
    providerOptions: { sandbox_mode: "read-only" },
  });
  const classifier = await hub.ownedCreateResult("classifier-create");
  hub.beginOwnedCreate("worker-create", "execution-worker", {
    prompt: "Implement the request",
    providerOptions: { sandbox_mode: "workspace-write" },
  });
  const worker = await hub.ownedCreateResult("worker-create");
  const classifierWorkspaceId = classifier.payload.agent?.workspaceId;
  const workerWorkspaceId = worker.payload.agent?.workspaceId;

  expect(classifierWorkspaceId).toEqual(expect.any(String));
  expect(workerWorkspaceId).toEqual(expect.any(String));
  expect(classifierWorkspaceId).not.toBe(workerWorkspaceId);
  expect(classifier.payload.agent?.cwd).toBe(hub.repoRoot());
  expect(worker.payload.agent?.cwd).toBe(hub.repoRoot());

  await hub.archiveExecution("execution-classifier", "archive-classifier");
  expect(await hub.archivedWorkspaceAt(classifierWorkspaceId!)).toEqual(expect.any(String));
  expect(await hub.archivedWorkspaceAt(workerWorkspaceId!)).toBeNull();

  await hub.archiveExecution("execution-worker", "archive-worker");
  expect(await hub.archivedWorkspaceAt(workerWorkspaceId!)).toEqual(expect.any(String));
});

test("Hub archives a running execution's Paseo-created worktree", async () => {
  const hub = await launchRelationship();
  hub.beginOwnedCreate("worktree-create", "execution-worktree", {
    worktree: { mode: "branch-off", newBranch: "hub-created-worktree", base: "main" },
    prompt: "sleep 30",
  });
  const worktreeCreated = await hub.ownedCreateResult("worktree-create");
  const workspaceId = worktreeCreated.payload.agent?.workspaceId;
  const worktreeCwd = hub.latestCreatedCwd();
  await hub.ownedRunningUpdate(worktreeCreated.payload.agentId!);
  const duringRun = await hub.worktreeState(worktreeCwd!);
  const response = await hub.archiveExecution("execution-worktree", "archive-worktree");
  const afterArchive = await hub.worktreeState(worktreeCwd!);

  expect(worktreeCreated).toMatchObject({
    type: "hub.execution.agent.create.response",
    payload: { success: true, agent: { cwd: worktreeCwd } },
  });
  expect(worktreeCwd).not.toBe(hub.repoRoot());
  expect(duringRun).toEqual({ exists: true, listed: true });
  expect(response).toMatchObject({ success: true, error: null, action: "archive" });
  expect(afterArchive).toEqual({ exists: false, listed: false });
  expect(workspaceId).toEqual(expect.any(String));
  expect(await hub.archivedWorkspaceAt(workspaceId!)).toEqual(expect.any(String));
  expect(await hub.ownedAgentArchivedAt(worktreeCreated.payload.agentId!)).toEqual(
    expect.any(String),
  );
});

test("a sibling workspace keeps an archived execution's worktree directory alive", async () => {
  const hub = await launchRelationship();
  hub.beginOwnedCreate("sibling-create", "execution-sibling", {
    worktree: { mode: "branch-off", newBranch: "hub-sibling-worktree", base: "main" },
    prompt: "sleep 30",
  });
  const created = await hub.ownedCreateResult("sibling-create");
  const targetWorkspaceId = created.payload.agent?.workspaceId;
  const worktreeCwd = hub.latestCreatedCwd()!;
  await hub.ownedRunningUpdate(created.payload.agentId!);
  const siblingWorkspaceId = await hub.createSiblingWorkspace(worktreeCwd);

  const response = await hub.archiveExecution("execution-sibling", "archive-sibling");

  expect(response).toMatchObject({ success: true, error: null });
  expect(targetWorkspaceId).toEqual(expect.any(String));
  expect(await hub.archivedWorkspaceAt(targetWorkspaceId!)).toEqual(expect.any(String));
  expect(await hub.archivedWorkspaceAt(siblingWorkspaceId)).toBeNull();
  expect(await hub.worktreeState(worktreeCwd)).toEqual({ exists: true, listed: true });
  expect(await hub.ownedAgentArchivedAt(created.payload.agentId!)).toEqual(expect.any(String));
});

test("archiving a second same-slug execution leaves the first worktree intact", async () => {
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
  const originalWorkspaceId = original.payload.agent?.workspaceId;
  await hub.ownedTurnCompletion(original.payload.agentId!);

  hub.beginOwnedCreate("reused-worktree-create", "execution-reused-worktree", {
    worktree,
    prompt: "sleep 30",
  });
  const reused = await hub.ownedCreateResult("reused-worktree-create");
  const secondWorktreeCwd = hub.latestCreatedCwd()!;
  const reusedWorkspaceId = reused.payload.agent?.workspaceId;
  await hub.ownedRunningUpdate(reused.payload.agentId!);

  const response = await hub.archiveExecution(
    "execution-reused-worktree",
    "archive-reused-worktree",
  );

  expect(response).toMatchObject({ success: true, error: null });
  expect(reusedWorkspaceId).toEqual(expect.any(String));
  expect(reusedWorkspaceId).not.toBe(originalWorkspaceId);
  expect(hub.pathsReferToSameLocation(reused.payload.agent!.cwd, worktreeCwd)).toBe(false);
  expect(hub.pathsReferToSameLocation(reused.payload.agent!.cwd, secondWorktreeCwd)).toBe(true);
  expect(await hub.worktreeState(worktreeCwd)).toEqual({ exists: true, listed: true });
  expect(await hub.worktreeState(secondWorktreeCwd)).toEqual({ exists: false, listed: false });
  expect(await hub.agentRemainsAvailable(original.payload.agentId!)).toBe(true);
  expect(await hub.ownedAgentArchivedAt(reused.payload.agentId!)).toEqual(expect.any(String));
  expect(await hub.ownedWorkspaceArchivedAt(reused.payload.agentId!)).toEqual(expect.any(String));
  expect(await hub.ownedWorkspaceArchivedAt(original.payload.agentId!)).toBeNull();
});

test("Hub resolves persisted execution ownership after daemon restart", async () => {
  const hub = await launchRelationship();
  hub.beginOwnedCreate("restart-create", "execution-restart", {
    worktree: { mode: "branch-off", newBranch: "hub-restart-worktree", base: "main" },
    prompt: "sleep 30",
  });
  const created = await hub.ownedCreateResult("restart-create");
  const workspaceId = created.payload.agent?.workspaceId;
  const worktreeCwd = hub.latestCreatedCwd()!;
  await hub.ownedRunningUpdate(created.payload.agentId!);

  await hub.restartDaemon();
  await hub.socketDialed();
  hub.connectLatestSocket();
  const response = await hub.archiveExecution("execution-restart", "archive-after-restart");

  expect(response).toMatchObject({ success: true, error: null });
  expect(await hub.ownedAgentArchivedAt(created.payload.agentId!)).toEqual(expect.any(String));
  expect(workspaceId).toEqual(expect.any(String));
  expect(await hub.archivedWorkspaceAt(workspaceId!)).toEqual(expect.any(String));
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
