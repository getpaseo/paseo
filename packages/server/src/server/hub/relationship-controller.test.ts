import { createHash } from "node:crypto";
import { platform } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import { HubRelationshipHarness } from "./test-utils/relationship-harness.js";

async function captureUnhandledRejections(action: () => Promise<void>): Promise<unknown[]> {
  const rejections: unknown[] = [];
  const capture = (reason: unknown) => rejections.push(reason);
  process.on("unhandledRejection", capture);
  try {
    await action();
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off("unhandledRejection", capture);
  }
  return rejections;
}

describe("Hub relationship", () => {
  let relationship: HubRelationshipHarness | null = null;

  afterEach(async () => {
    await relationship?.close();
    relationship = null;
  });

  test("the CLI connects, reports status, and disconnects through the daemon", async () => {
    relationship = await HubRelationshipHarness.start();
    const connected = await relationship.beginConnect().result;
    relationship.connectLatestSocket();

    const status = await relationship.status();
    const enrollment = relationship.enrollmentAttempts()[0];
    const secret = relationship.relationshipFile()?.credential?.secret;
    const disconnected = await relationship.disconnect();

    expect(connected.state).toBe("connecting");
    expect(status.state).toBe("connected");
    expect(relationship.loggableValues(status)).not.toContain(secret);
    expect(relationship.loggableValues(status)).not.toContain(enrollment.credentialVerifier);
    expect(relationship.loggableValues(status)).not.toContain(enrollment.token);
    expect(relationship.loggableValues(status)).not.toContain(enrollment.idempotencyKey);
    expect(disconnected.state).toBe("not_connected");
  }, 30_000);

  test("Hub URLs cannot persist embedded credentials", async () => {
    relationship = await HubRelationshipHarness.start();

    await expect(
      relationship.beginConnect("ceremony-token", "https://user:password@hub.example").result,
    ).rejects.toThrow();

    expect(relationship.relationshipFile()).toBeNull();
    expect(relationship.enrollmentAttempts()).toEqual([]);
  });

  test("an authenticated external socket can manage the Hub relationship", async () => {
    relationship = await HubRelationshipHarness.start();

    const responses = await relationship.manageRelationshipFromExternalSocket();

    expect(responses.map((response) => response.type)).toEqual([
      "hub.management.daemon.connect.response",
      "hub.management.daemon.get_status.response",
      "hub.management.daemon.disconnect.response",
    ]);
    expect(relationship.enrollmentAttempts()).toHaveLength(1);
    expect(relationship.relationshipFile()).toBeNull();
  });

  test("an authenticated browser socket can manage the Hub relationship", async () => {
    relationship = await HubRelationshipHarness.start();

    const response = await relationship.connectFromBrowserSocket();

    expect(response.type).toBe("hub.management.daemon.connect.response");
    expect(relationship.enrollmentAttempts()).toHaveLength(1);
    expect(relationship.relationshipFile()?.state).toBe("active");
  });

  test("persists private generated authority before enrollment and active before dialing", async () => {
    relationship = await HubRelationshipHarness.start();
    const privateFileMode = platform() === "win32" ? 0o666 : 0o600;
    relationship.holdEnrollment();
    const connecting = relationship.beginConnect("one-time-token");

    const enrollment = await relationship.enrollmentBegins();
    const pending = relationship.enrollmentInvocation();

    expect(pending).toMatchObject({
      record: {
        state: "pending",
        relationship: {
          daemonId: enrollment.daemonId,
          idempotencyKey: enrollment.idempotencyKey,
        },
        credential: { secret: expect.any(String) },
        enrollment: { token: "one-time-token" },
        identity: { serverId: expect.any(String), daemonPublicKey: expect.any(String) },
      },
    });
    expect(pending.mode).toBe(privateFileMode);
    const secret = pending.record.credential?.secret;
    expect(secret).toEqual(expect.any(String));
    expect(enrollment.credentialVerifier).toBe(
      createHash("sha256")
        .update(secret ?? "")
        .digest("base64url"),
    );
    relationship.completeEnrollment();
    await connecting.result;
    await relationship.socketDialed();
    expect(relationship.socketInvocation()).toMatchObject({
      mode: privateFileMode,
      record: { state: "active", relationship: { daemonId: enrollment.daemonId } },
    });
  });

  test("Hub enrollment cannot widen the daemon's locally granted scopes", async () => {
    relationship = await HubRelationshipHarness.start();
    relationship.returnEnrollmentScopes(["hub.execution.*", "*"]);

    await relationship.beginConnect().result;
    relationship.connectLatestSocket();
    const responses = relationship.sendHubRequestOnLatest({
      type: "daemon.get_status.request",
      requestId: "scope-escalation",
    });

    expect(relationship.relationshipFile()?.relationship.scopes).toEqual(["hub.execution.*"]);
    expect(responses).toContainEqual({
      type: "rpc_error",
      payload: {
        requestId: "scope-escalation",
        requestType: "daemon.get_status.request",
        error: "Session is not authorized for daemon.get_status.request",
        code: "access_denied",
      },
    });
  });

  test("a lost enrollment response reuses the exact ceremony", async () => {
    relationship = await HubRelationshipHarness.start();
    relationship.holdEnrollment();
    const connecting = relationship.beginConnect("same-token");
    await relationship.enrollmentBegins();
    relationship.loseEnrollmentResponse();
    await connecting.result;

    await relationship.retry();
    const attempts = relationship.enrollmentAttempts();

    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(relationship.enrolledRelationships()).toBe(1);
  });

  test("a fresh token replaces the token for a pending enrollment ceremony", async () => {
    relationship = await HubRelationshipHarness.start();
    relationship.holdEnrollment();
    const firstConnect = relationship.beginConnect("expired-token");
    const firstResult = expect(firstConnect.result).resolves.toMatchObject({
      state: "reconnecting",
    });
    await relationship.enrollmentBegins();
    relationship.loseEnrollmentResponse();
    await firstResult;

    relationship.holdEnrollment();
    const secondConnect = relationship.beginConnect("fresh-token");
    const secondResult = expect(secondConnect.result).resolves.toMatchObject({
      state: "connecting",
    });
    const retried = await relationship.enrollmentBegins();

    expect(retried.token).toBe("fresh-token");
    expect(relationship.relationshipFile()?.enrollment?.token).toBe("fresh-token");
    relationship.completeEnrollment();
    await secondResult;
  });

  test("a stale enrollment rejection cannot discard a fresh pending ceremony", async () => {
    relationship = await HubRelationshipHarness.start();
    relationship.holdEnrollment();
    const expiredConnect = relationship.beginConnect("expired-token");
    await relationship.enrollmentBegins();

    relationship.holdEnrollment();
    const freshConnect = relationship.beginConnect("fresh-token");
    const freshEnrollment = await relationship.enrollmentBegins();
    relationship.rejectEnrollment(0, 403);
    await expiredConnect.result;

    expect(relationship.relationshipFile()?.enrollment?.token).toBe("fresh-token");
    expect(relationship.pendingRelationshipRetries()).toBe(0);

    relationship.completeEnrollment();
    await freshConnect.result;

    expect(freshEnrollment.token).toBe("fresh-token");
    expect(relationship.relationshipFile()?.state).toBe("active");
    expect(relationship.enrollmentAttempts()).toHaveLength(2);
    expect(relationship.pendingRelationshipRetries()).toBe(0);
  });

  test("a rejected pending enrollment is discarded without blocking daemon restart", async () => {
    relationship = await HubRelationshipHarness.start();
    relationship.holdEnrollment();
    const connecting = relationship.beginConnect("expired-token");
    await relationship.enrollmentBegins();
    relationship.loseEnrollmentResponse();
    await connecting.result;
    relationship.rejectNextEnrollment(401);

    await relationship.restartDaemon();

    expect(await relationship.status()).toMatchObject({ state: "not_connected" });
    expect(relationship.relationshipFile()).toBeNull();
  });

  test("a scheduled enrollment rejection is contained after removing pending authority", async () => {
    relationship = await HubRelationshipHarness.start();
    relationship.holdEnrollment();
    const connecting = relationship.beginConnect("expired-token");
    await relationship.enrollmentBegins();
    relationship.loseEnrollmentResponse();
    await connecting.result;
    relationship.rejectNextEnrollment(403);

    const unhandledRejections = await captureUnhandledRejections(() => relationship!.retry());
    const status = await relationship.status();

    expect(status).toMatchObject({ state: "not_connected" });
    expect(relationship.relationshipFile()).toBeNull();
    expect(relationship.pendingRelationshipRetries()).toBe(0);
    expect(unhandledRejections).toEqual([]);
  });

  test.each(["{not-json", JSON.stringify({ version: 1, state: "unknown" })])(
    "an invalid relationship file is quarantined without blocking daemon startup",
    async (contents) => {
      relationship = await HubRelationshipHarness.start();
      await relationship.corruptRelationshipFile(contents);

      await relationship.startStoppedDaemon();

      expect(await relationship.status()).toMatchObject({ state: "not_connected" });
      expect(relationship.relationshipFile()).toBeNull();
      expect(await relationship.quarantinedRelationshipFiles()).toHaveLength(1);
    },
  );

  test.each([
    ["a non-HTTP scheme", "ftp://hub.test"],
    ["embedded credentials", "https://user:password@hub.test"],
    ["a query", "https://hub.test?token=secret"],
    ["a fragment", "https://hub.test#secret"],
  ])("a persisted Hub origin with %s is quarantined before startup", async (_, hubOrigin) => {
    relationship = await HubRelationshipHarness.start();
    await relationship.corruptRelationshipFile(
      JSON.stringify({
        version: 1,
        state: "pending",
        relationship: {
          daemonId: "daemon-1",
          idempotencyKey: "ceremony-1",
          hubOrigin,
          createdAt: "2026-07-13T00:00:00.000Z",
          scopes: ["hub.execution.*"],
        },
        credential: { secret: "credential" },
        enrollment: { token: "enrollment-token" },
        identity: { serverId: "server-1", daemonPublicKey: "public-key" },
      }),
    );

    await relationship.startStoppedDaemon();

    expect(await relationship.status()).toMatchObject({ state: "not_connected" });
    expect(relationship.relationshipFile()).toBeNull();
    expect(await relationship.quarantinedRelationshipFiles()).toHaveLength(1);
    expect(relationship.enrollmentAttempts()).toEqual([]);
  });

  test("a persisted Hub relationship cannot widen its local execution scope", async () => {
    relationship = await HubRelationshipHarness.start();
    await relationship.beginConnect().result;
    const persisted = relationship.relationshipFile();
    expect(persisted).not.toBeNull();
    persisted!.relationship.scopes = ["*"];
    await relationship.corruptRelationshipFile(JSON.stringify(persisted));
    const socketAttemptsBeforeRestart = relationship.socketAttempts();

    await relationship.startStoppedDaemon();

    expect(await relationship.status()).toMatchObject({ state: "not_connected" });
    expect(relationship.relationshipFile()).toBeNull();
    expect(await relationship.quarantinedRelationshipFiles()).toHaveLength(1);
    expect(relationship.socketAttempts()).toBe(socketAttemptsBeforeRestart);
  });

  test("a persisted non-WebSocket transport is quarantined before daemon startup", async () => {
    relationship = await HubRelationshipHarness.start();
    await relationship.corruptRelationshipFile(
      JSON.stringify({
        version: 1,
        state: "active",
        relationship: {
          id: "relationship-1",
          idempotencyKey: "ceremony-1",
          hubOrigin: "https://hub.test",
          createdAt: "2026-07-13T00:00:00.000Z",
          scopes: ["hub.execution.*"],
        },
        credential: { secret: "credential" },
        transport: { kind: "direct_websocket", webSocketUrl: "ftp://hub.test/daemon" },
      }),
    );

    await relationship.startStoppedDaemon();

    expect(await relationship.status()).toMatchObject({ state: "not_connected" });
    expect(relationship.relationshipFile()).toBeNull();
    expect(await relationship.quarantinedRelationshipFiles()).toHaveLength(1);
    expect(relationship.socketAttempts()).toBe(0);
  });

  test("a persisted WebSocket transport with a fragment is quarantined before startup", async () => {
    relationship = await HubRelationshipHarness.start();
    await relationship.corruptRelationshipFile(
      JSON.stringify({
        version: 1,
        state: "active",
        relationship: {
          id: "relationship-1",
          idempotencyKey: "ceremony-1",
          hubOrigin: "https://hub.test",
          createdAt: "2026-07-13T00:00:00.000Z",
          scopes: ["hub.execution.*"],
        },
        credential: { secret: "credential" },
        transport: {
          kind: "direct_websocket",
          webSocketUrl: "wss://hub.test/daemon#fragment",
        },
      }),
    );

    await relationship.startStoppedDaemon();

    expect(await relationship.status()).toMatchObject({ state: "not_connected" });
    expect(relationship.relationshipFile()).toBeNull();
    expect(await relationship.quarantinedRelationshipFiles()).toHaveLength(1);
    expect(relationship.socketAttempts()).toBe(0);
  });

  test("disconnect revokes an ambiguous pending enrollment before removing local authority", async () => {
    relationship = await HubRelationshipHarness.start();
    relationship.holdEnrollment();
    const connecting = relationship.beginConnect("one-time-token");
    const enrollment = await relationship.enrollmentBegins();
    const credential = relationship.relationshipFile()?.credential?.secret;
    relationship.loseEnrollmentResponse();
    await connecting.result;
    relationship.failRevocations(2);

    const disconnected = await relationship.disconnect();
    expect(disconnected.state).toBe("disconnecting");
    expect(relationship.relationshipFile()?.state).toBe("disconnecting");

    await relationship.restartDaemon();
    await relationship.retry();

    expect(relationship.revocationAttempts()).toBe(3);
    expect(relationship.latestRevocation()).toEqual(
      expect.objectContaining({
        daemonId: enrollment.daemonId,
        hubOrigin: enrollment.hubOrigin,
        credential,
      }),
    );
    expect(relationship.relationshipFile()).toBeNull();
  });

  test("disconnect revokes only after an in-flight enrollment settles", async () => {
    relationship = await HubRelationshipHarness.start();
    relationship.holdEnrollment();
    const connecting = relationship.beginConnect("one-time-token");
    const enrollment = await relationship.enrollmentBegins();

    const disconnecting = relationship.beginDisconnect();
    await relationship.relationshipStateBecomes("disconnecting");
    expect(relationship.revocationAttempts()).toBe(0);

    relationship.completeEnrollment();
    await connecting.result;
    const disconnected = await disconnecting.result;

    expect(disconnected.state).toBe("not_connected");
    expect(relationship.latestRevocation()?.daemonId).toBe(enrollment.daemonId);
    expect(relationship.revocationAttempts()).toBe(1);
    expect(relationship.socketAttempts()).toBe(0);
    expect(relationship.relationshipFile()).toBeNull();
  });

  test("daemon restart reconnects the same durable relationship", async () => {
    relationship = await HubRelationshipHarness.start();
    await relationship.beginConnect().result;
    const id = relationship.relationshipFile()?.relationship.daemonId;
    relationship.connectLatestSocket();
    await relationship.socketDialed();

    await relationship.restartDaemon();
    await relationship.socketDialed();

    expect(relationship.relationshipFile()?.relationship.daemonId).toBe(id);
    expect(relationship.socketAttempts()).toBe(2);
  });

  test("daemon restart closes an interrupted owned turn without replaying its prompt", async () => {
    relationship = await HubRelationshipHarness.start();
    await relationship.beginConnect().result;
    await relationship.socketDialed();
    relationship.connectLatestSocket();
    const daemonId = relationship.relationshipFile()?.relationship.daemonId;
    const prompt = "sleep 30";
    relationship.beginOwnedCreate("running-create", "execution-running", {
      prompt,
      modeId: "full-access",
    });
    const created = await relationship.ownedCreateResult("running-create");
    const running = await relationship.ownedRunningUpdate(created.payload.agentId!);

    await relationship.restartDaemon();
    await relationship.socketDialed();
    relationship.connectLatestSocket();
    relationship.beginOwnedCreate("running-duplicate", "execution-running", { prompt });
    const duplicate = await relationship.ownedCreateResult("running-duplicate");
    expect(duplicate).toMatchObject({
      payload: {
        success: true,
        executionId: "execution-running",
        agentId: created.payload.agentId,
        agent: { id: created.payload.agentId, status: "closed" },
      },
    });
    const durableAgentIds = await relationship.durableOwnedAgentIds();

    expect(running).toMatchObject({
      executionId: "execution-running",
      agentId: created.payload.agentId,
      agent: { id: created.payload.agentId, status: "running" },
    });
    expect(relationship.relationshipFile()?.relationship.daemonId).toBe(daemonId);
    expect(durableAgentIds).toEqual([created.payload.agentId]);
    expect(relationship.providerCreations()).toBe(1);
    expect(relationship.providerResumes()).toBe(0);
    expect(relationship.providerPromptTexts()).toEqual([prompt]);
    expect(relationship.latestOwnedTurnCompletions(created.payload.agentId!)).toBe(0);
  });

  test("an owned execution does not persist a daemon-restart prompt intent", async () => {
    relationship = await HubRelationshipHarness.start();
    await relationship.beginConnect().result;
    relationship.connectLatestSocket();
    relationship.beginOwnedCreate("intent-create", "execution-intent", { prompt: "sleep 30" });
    await relationship.ownedCreateResult("intent-create");

    expect(await relationship.hubExecutionIntentFiles()).toEqual([]);
  });

  test("an ordinary duplicate create does not replay a completed owned turn", async () => {
    relationship = await HubRelationshipHarness.start();
    await relationship.beginConnect().result;
    relationship.connectLatestSocket();
    const prompt = "respond with exactly: completed once";
    relationship.beginOwnedCreate("completed-create", "execution-completed", { prompt });
    const created = await relationship.ownedCreateResult("completed-create");
    await relationship.ownedTurnCompletion(created.payload.agentId!);

    relationship.beginOwnedCreate("completed-duplicate", "execution-completed", { prompt });
    const duplicate = await relationship.ownedCreateResult("completed-duplicate");

    expect(duplicate).toMatchObject({
      type: "hub.execution.agent.create.response",
      payload: {
        success: true,
        executionId: "execution-completed",
        agentId: created.payload.agentId,
        agent: { status: "idle" },
      },
    });
    expect(relationship.providerPromptTexts()).toEqual([prompt]);
    expect(await relationship.durableOwnedAgentIds()).toEqual([created.payload.agentId]);
    expect(relationship.latestOwnedTurnCompletions(created.payload.agentId!)).toBe(1);
  });

  test("daemon restart closes a completed owned session without replaying its prompt", async () => {
    relationship = await HubRelationshipHarness.start();
    await relationship.beginConnect().result;
    relationship.connectLatestSocket();
    const prompt = "respond with exactly: already completed";
    relationship.beginOwnedCreate("idle-create", "execution-idle", { prompt });
    const created = await relationship.ownedCreateResult("idle-create");
    await relationship.ownedTurnCompletion(created.payload.agentId!);

    await relationship.restartDaemon();
    await relationship.socketDialed();
    relationship.connectLatestSocket();
    relationship.beginOwnedCreate("idle-retry", "execution-idle", { prompt });
    const retried = await relationship.ownedCreateResult("idle-retry");

    expect(retried).toMatchObject({
      payload: {
        executionId: "execution-idle",
        agentId: created.payload.agentId,
        agent: { id: created.payload.agentId, status: "closed" },
      },
    });
    expect(relationship.providerPromptTexts()).toEqual([prompt]);
    expect(relationship.providerResumes()).toBe(0);
    expect(relationship.latestOwnedTurnCompletions(created.payload.agentId!)).toBe(0);
  });

  test("daemon restart closes a failed owned session without replaying its prompt", async () => {
    relationship = await HubRelationshipHarness.start();
    await relationship.beginConnect().result;
    relationship.connectLatestSocket();
    const prompt = "emit a turn failure";
    relationship.beginOwnedCreate("failed-create", "execution-failed", { prompt });
    const created = await relationship.ownedCreateResult("failed-create");
    const failed = await relationship.ownedTurnFailure(created.payload.agentId!);

    await relationship.restartDaemon();
    await relationship.socketDialed();
    relationship.connectLatestSocket();
    relationship.beginOwnedCreate("failed-retry", "execution-failed", { prompt });
    const retried = await relationship.ownedCreateResult("failed-retry");

    expect(failed).toMatchObject({
      executionId: "execution-failed",
      agentId: created.payload.agentId,
      event: { type: "turn_failed" },
    });
    expect(retried).toMatchObject({
      payload: {
        executionId: "execution-failed",
        agentId: created.payload.agentId,
        agent: { id: created.payload.agentId, status: "closed" },
      },
    });
    expect(relationship.providerPromptTexts()).toEqual([prompt]);
    expect(relationship.providerResumes()).toBe(0);
    expect(relationship.latestOwnedTurnCompletions(created.payload.agentId!)).toBe(0);
  });

  test("Hub revocation leaves no execution intent artifacts", async () => {
    relationship = await HubRelationshipHarness.start();
    await relationship.beginConnect().result;
    relationship.connectLatestSocket();
    relationship.beginOwnedCreate("revoked-create", "execution-revoked", { prompt: "sleep 30" });
    await relationship.ownedCreateResult("revoked-create");

    relationship.rejectRelationship(401);

    expect(await relationship.hubExecutionIntentFiles()).toEqual([]);
  });

  test("stale socket generations cannot replace or unregister the current socket", async () => {
    relationship = await HubRelationshipHarness.start();
    await relationship.beginConnect().result;
    relationship.closeSocket(0, 1006);
    await relationship.retry();
    relationship.connectSocket(1);

    relationship.connectSocket(0);
    relationship.closeSocket(0, 1000);
    const messages = relationship.sendHubRequestOnLatest({
      type: "daemon.get_status.request",
      requestId: "still-current",
    });

    expect(messages).toContainEqual({
      type: "rpc_error",
      payload: {
        requestId: "still-current",
        requestType: "daemon.get_status.request",
        error: "Session is not authorized for daemon.get_status.request",
        code: "access_denied",
      },
    });
    expect(relationship.socketAttempts()).toBe(2);
  });

  test("replayed create across socket generations shares one pending durable execution", async () => {
    relationship = await HubRelationshipHarness.start();
    await relationship.beginConnect().result;
    relationship.connectLatestSocket();
    relationship.holdAgentCreation();
    relationship.beginOwnedCreate("first-create");
    await relationship.agentCreationAttempts(1);

    relationship.closeLatestSocket(1006);
    await relationship.retry();
    relationship.connectLatestSocket();
    relationship.beginOwnedCreate("replayed-create");
    relationship.finishAgentCreation();

    const replayed = await relationship.ownedCreateResult("replayed-create");
    const durableAgentIds = await relationship.durableOwnedAgentIds();

    expect(relationship.socketDeliveredResponse(0, "first-create")).toBe(false);
    expect(replayed).toMatchObject({
      type: "hub.execution.agent.create.response",
      payload: {
        success: true,
        executionId: "execution-race",
        agentId: durableAgentIds[0],
      },
    });
    expect(relationship.providerCreations()).toBe(1);
    expect(durableAgentIds).toHaveLength(1);
  });

  test("idempotent retry waits for a pending create across socket generations", async () => {
    relationship = await HubRelationshipHarness.start();
    await relationship.beginConnect().result;
    relationship.connectLatestSocket();
    relationship.holdAgentCreation();
    relationship.beginOwnedCreate("pending-create", "pending-execution");
    await relationship.agentCreationAttempts(1);

    relationship.closeLatestSocket(1006);
    await relationship.retry();
    relationship.connectLatestSocket();
    relationship.beginOwnedCreate("pending-retry", "pending-execution");
    relationship.finishAgentCreation();

    await expect(relationship.ownedCreateResult("pending-retry")).resolves.toMatchObject({
      payload: {
        executionId: "pending-execution",
        agentId: expect.any(String),
        agent: { id: expect.any(String) },
      },
    });
    expect(relationship.providerCreations()).toBe(1);
    expect(await relationship.durableOwnedAgentIds()).toHaveLength(1);
  });

  test("force disconnect fences a pending create before removing authority", async () => {
    relationship = await HubRelationshipHarness.start();
    await relationship.beginConnect().result;
    relationship.connectLatestSocket();
    relationship.holdAgentCreation();
    relationship.beginOwnedCreate("cancelled-create", "cancelled-execution", {
      worktree: { mode: "branch-off", newBranch: "cancelled-hub-create" },
    });
    await relationship.agentCreationAttempts(1);

    const disconnecting = relationship.beginDisconnect(true);
    await relationship.relationshipStateBecomes(null);
    relationship.finishAgentCreation();
    await disconnecting.result;

    expect(relationship.activeOwnedAgentIds()).toEqual([]);
    expect(await relationship.durableOwnedAgentIds()).toEqual([]);
    expect(await relationship.listedWorktrees()).toHaveLength(1);
  });

  test("re-enrollment gives the same daemon fresh execution authority", async () => {
    relationship = await HubRelationshipHarness.start();
    await relationship.beginConnect().result;
    relationship.connectLatestSocket();
    relationship.beginOwnedCreate("first-create", "first-execution");
    const first = await relationship.ownedCreateResult("first-create");
    const daemonId = relationship.relationshipFile()?.relationship.daemonId;

    await relationship.disconnect();
    await relationship.beginConnect("fresh-token").result;
    relationship.connectLatestSocket();
    relationship.beginOwnedCreate("second-create", "second-execution");
    const second = await relationship.ownedCreateResult("second-create");

    expect(relationship.relationshipFile()?.relationship.daemonId).toBe(daemonId);
    expect(first).toMatchObject({ payload: { success: true, executionId: "first-execution" } });
    expect(second).toMatchObject({ payload: { success: true, executionId: "second-execution" } });
    expect(relationship.providerCreations()).toBe(2);
  });

  test("daemon shutdown fences a pending create before closing owned agents", async () => {
    relationship = await HubRelationshipHarness.start();
    await relationship.beginConnect().result;
    relationship.connectLatestSocket();
    relationship.holdAgentCreation();
    relationship.beginOwnedCreate("shutdown-create", "execution-shutdown", { prompt: "sleep 30" });
    await relationship.agentCreationAttempts(1);

    const shutdown = relationship.shutdownDaemon();
    relationship.finishAgentCreation();
    await shutdown;

    expect(relationship.socketDeliveredResponse(0, "shutdown-create")).toBe(false);
    expect(await relationship.durableOwnedAgentIdsOnDisk()).toEqual([]);
  });

  test.each([
    [4403, "Hub revoked this relationship"],
    [401, "Hub rejected socket authentication (401)"],
    [403, "Hub rejected socket authentication (403)"],
  ] as const)("authentication rejection %s revokes permanently", async (code, reason) => {
    relationship = await HubRelationshipHarness.start();
    await relationship.beginConnect("private-token").result;
    const enrollment = relationship.enrollmentAttempts()[0];
    const secret = relationship.relationshipFile()?.credential?.secret;
    relationship.rejectRelationship(code);

    await relationship.restartDaemon();
    const status = await relationship.status();
    const persisted = relationship.relationshipFile();

    expect(status).toMatchObject({
      state: "revoked",
      daemonId: enrollment.daemonId,
      hub: "https://hub.test",
      scopes: "hub.execution.*",
      error: reason,
    });
    expect(persisted?.state).toBe("revoked");
    expect(persisted?.relationship).toMatchObject({
      daemonId: enrollment.daemonId,
      hubOrigin: "https://hub.test",
      scopes: ["hub.execution.*"],
    });
    expect(persisted?.reason).toBe(reason);
    expect(persisted).not.toHaveProperty("credential");
    expect(persisted).not.toHaveProperty("relationship.idempotencyKey");
    expect(relationship.socketAttempts()).toBe(1);
    const loggable = relationship.loggableValues(status);
    const reconstructed = JSON.stringify({ status, persisted });
    expect(reconstructed).not.toContain(secret);
    expect(reconstructed).not.toContain(enrollment.credentialVerifier);
    expect(reconstructed).not.toContain(enrollment.token);
    expect(reconstructed).not.toContain(enrollment.idempotencyKey);
    expect(loggable).not.toContain(secret);
    expect(loggable).not.toContain(enrollment.credentialVerifier);
    expect(loggable).not.toContain(enrollment.token);
    expect(loggable).not.toContain(enrollment.idempotencyKey);
  });

  test("offline disconnect retries across runtime and restart without opening a socket", async () => {
    relationship = await HubRelationshipHarness.start();
    await relationship.beginConnect().result;
    relationship.connectLatestSocket();
    relationship.failRevocations(3);

    const disconnecting = await relationship.disconnect();
    await relationship.retry();
    await relationship.restartDaemon();
    await relationship.retry();

    expect(disconnecting.state).toBe("disconnecting");
    expect(relationship.revocationAttempts()).toBe(4);
    expect(relationship.socketAttempts()).toBe(1);
    expect(relationship.relationshipFile()).toBeNull();
  });

  test("successful disconnect clears a transient revocation error", async () => {
    relationship = await HubRelationshipHarness.start();
    await relationship.beginConnect().result;
    relationship.failRevocations(1);

    const disconnecting = await relationship.disconnect();
    await relationship.retry();

    expect(disconnecting).toMatchObject({ state: "disconnecting", error: expect.any(String) });
    expect(await relationship.status()).toMatchObject({ state: "not_connected", error: null });
  });

  test("force disconnect removes local authority and reports the remote warning", async () => {
    relationship = await HubRelationshipHarness.start();
    await relationship.beginConnect().result;
    relationship.failRevocations(1);
    await relationship.disconnect();

    const forced = await relationship.disconnect(true);

    expect(forced.state).toBe("not_connected");
    expect(forced.warning).toContain("remote revocation");
    expect(relationship.relationshipFile()).toBeNull();
  });

  test("disconnect leaves no intent artifacts and shutdown closes the owned agent", async () => {
    relationship = await HubRelationshipHarness.start();
    await relationship.beginConnect().result;
    relationship.connectLatestSocket();
    relationship.beginOwnedCreate("orphan-create", "execution-orphan", { prompt: "sleep 30" });
    const created = await relationship.ownedCreateResult("orphan-create");
    expect(created).toMatchObject({ payload: { agent: { status: "running" } } });

    await relationship.disconnect(true);
    expect(await relationship.hubExecutionIntentFiles()).toEqual([]);
    await relationship.restartDaemon();

    expect(await relationship.storedOwnedStatus(created.payload.agentId!)).toBe("closed");
  });
});
