import { expect, test, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  HostRestartingOperationError,
  RestartDrainConflictError,
  RestartDrainTimeoutError,
} from "@getpaseo/client/internal/daemon-client";
import { createTestPaseoDaemon, DaemonClient } from "./test-utils/index.js";
import { createTestAgentClients } from "./test-utils/fake-agent-client.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "restart-drain-"));
}

async function startHeldTurn(
  daemon: Awaited<ReturnType<typeof createTestPaseoDaemon>>,
  client: DaemonClient,
  prompt: string,
) {
  await client.connect();
  await client.fetchAgents({ subscribe: {} });
  const agent = await client.createAgent({
    provider: "codex",
    cwd: tmpCwd(),
    title: "Held turn agent",
    modeId: "full-access",
    model: "gpt-5.4-mini",
    initialPrompt: prompt,
  });
  expect(agent.status).toBe("running");
  return agent;
}

function holdMatching(pattern: RegExp) {
  const gates: Array<{ promise: Promise<void>; resolve: () => void }> = [];
  const agentClients = createTestAgentClients({
    holdTurnFor: (prompt) => {
      if (!pattern.test(prompt)) return null;
      const gate = deferred();
      gates.push(gate);
      return gate.promise;
    },
  });
  return { agentClients, gates };
}

test("restart --wait-idle waits for a running turn, rejects new prompts retryably, and lets the turn finish", async () => {
  const { agentClients, gates } = holdMatching(/hold/i);
  const daemon = await createTestPaseoDaemon({ mcpEnabled: false, agentClients });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    // Raw rejection: auto-resend is exercised by the client unit tests and the
    // short-drain e2e below.
    hostRestartAutoResend: false,
  });
  try {
    const agent = await startHeldTurn(daemon, client, "hold this turn");

    const progress: string[][] = [];
    let settled = false;
    const restart = client
      .restartServer("test_drain", undefined, {
        waitIdle: true,
        idleTimeoutMs: 5_000,
        onDrainProgress: (status) => progress.push(status.runningAgents),
      })
      .then((ack) => {
        settled = true;
        return ack;
      });

    await vi.waitFor(() => expect(progress.length).toBeGreaterThan(0));
    expect(progress.some((ids) => ids.includes(agent.id))).toBe(true);

    // The restart must not resolve while the turn is still running.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(settled).toBe(false);

    // A prompt submitted during drain is provably rejected, not silently queued.
    let rejection: unknown;
    try {
      await client.sendAgentMessage(agent.id, "a prompt during drain");
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(HostRestartingOperationError);
    expect((rejection as HostRestartingOperationError).message).toBe("host_restarting");

    // Release the fake turn: the drain completes and the turn finishes cleanly.
    expect(gates.length).toBeGreaterThan(0);
    gates[0]!.resolve();
    const ack = await restart;
    expect(ack.status).toBe("restart_requested");

    const final = await client.waitForFinish(agent.id, 5_000);
    expect(final.status).toBe("idle");
    const fetched = await client.fetchAgent({ agentId: agent.id });
    expect(fetched?.agent.status).toBe("idle");
  } finally {
    for (const gate of gates) gate.resolve();
    await client.close();
    await daemon.close();
  }
});

test("restart --wait-idle fails on timeout without restarting and stops draining", async () => {
  const { agentClients, gates } = holdMatching(/hold/i);
  const daemon = await createTestPaseoDaemon({ mcpEnabled: false, agentClients });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    hostRestartResendTimeoutMs: 100,
  });
  try {
    const agent = await startHeldTurn(daemon, client, "hold this turn");

    await expect(
      client.restartServer("test_timeout", undefined, { waitIdle: true, idleTimeoutMs: 150 }),
    ).rejects.toBeInstanceOf(RestartDrainTimeoutError);

    // The daemon was not restarted and the turn is untouched.
    const stillRunning = await client.fetchAgent({ agentId: agent.id });
    expect(stillRunning?.agent.status).toBe("running");

    // Draining ended cleanly: release the turn, then a fresh prompt is admitted.
    gates[0]!.resolve();
    const finished = await client.waitForFinish(agent.id, 5_000);
    expect(finished.status).toBe("idle");

    await client.sendAgentMessage(agent.id, "after timeout");
    const after = await client.waitForFinish(agent.id, 5_000);
    expect(after.status).toBe("idle");
  } finally {
    for (const gate of gates) gate.resolve();
    await client.close();
    await daemon.close();
  }
});

test("restart --wait-idle --force swaps on drain timeout as before", async () => {
  const { agentClients, gates } = holdMatching(/hold/i);
  const daemon = await createTestPaseoDaemon({ mcpEnabled: false, agentClients });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    hostRestartResendTimeoutMs: 100,
  });
  try {
    const agent = await startHeldTurn(daemon, client, "hold this turn");

    const ack = await client.restartServer("test_force", undefined, {
      waitIdle: true,
      idleTimeoutMs: 150,
      force: true,
    });
    expect(ack.status).toBe("restart_requested");

    // Force swapped while the turn was still running (today's behaviour).
    const stillRunning = await client.fetchAgent({ agentId: agent.id });
    expect(stillRunning?.agent.status).toBe("running");
  } finally {
    for (const gate of gates) gate.resolve();
    await client.close();
    await daemon.close();
  }
});

test("a second --wait-idle restart is rejected while a drain already owns the swap", async () => {
  const { agentClients, gates } = holdMatching(/hold/i);
  const daemon = await createTestPaseoDaemon({ mcpEnabled: false, agentClients });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    hostRestartResendTimeoutMs: 100,
  });
  try {
    await startHeldTurn(daemon, client, "hold this turn");

    let draining = false;
    const first = client.restartServer("first_drain", undefined, {
      waitIdle: true,
      idleTimeoutMs: 5_000,
      onDrainProgress: () => {
        draining = true;
      },
    });
    await vi.waitFor(() => expect(draining).toBe(true));

    await expect(
      client.restartServer("second_drain", undefined, { waitIdle: true, idleTimeoutMs: 1_000 }),
    ).rejects.toBeInstanceOf(RestartDrainConflictError);

    expect(gates.length).toBeGreaterThan(0);
    gates[0]!.resolve();
    const ack = await first;
    expect(ack.status).toBe("restart_requested");
  } finally {
    for (const gate of gates) gate.resolve();
    await client.close();
    await daemon.close();
  }
});

test("a forced restart supersedes an active drain and still acknowledges the drained request", async () => {
  const { agentClients, gates } = holdMatching(/hold/i);
  const daemon = await createTestPaseoDaemon({ mcpEnabled: false, agentClients });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    hostRestartResendTimeoutMs: 100,
  });
  try {
    await startHeldTurn(daemon, client, "hold this turn");

    let draining = false;
    const drained = client.restartServer("drain", undefined, {
      waitIdle: true,
      idleTimeoutMs: 5_000,
      onDrainProgress: () => {
        draining = true;
      },
    });
    await vi.waitFor(() => expect(draining).toBe(true));

    const forced = await client.restartServer("force", undefined, { force: true });
    expect(forced.status).toBe("restart_requested");
    // The superseded drain acknowledges instead of hanging until its RPC timeout.
    const acked = await drained;
    expect(acked.status).toBe("restart_requested");
  } finally {
    for (const gate of gates) gate.resolve();
    await client.close();
    await daemon.close();
  }
});

test("a prompt rejected during a drain is auto-accepted once the drain times out", async () => {
  const { agentClients, gates } = holdMatching(/hold/i);
  const daemon = await createTestPaseoDaemon({ mcpEnabled: false, agentClients });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    hostRestartRetryIntervalMs: 50,
    hostRestartResendGraceMs: 500,
    hostRestartResendTimeoutMs: 200,
  });
  try {
    const heldAgent = await startHeldTurn(daemon, client, "hold this turn");
    // A separate idle agent receives the prompt, so admission is the only thing
    // standing between the rejected send and its acceptance.
    const idleAgent = await client.createAgent({
      provider: "codex",
      cwd: tmpCwd(),
      title: "Idle agent",
      modeId: "full-access",
      model: "gpt-5.4-mini",
    });
    expect(idleAgent.status).toBe("idle");

    const drain = client.restartServer("short_drain", undefined, {
      waitIdle: true,
      idleTimeoutMs: 300,
    });
    // Attach the rejection handler immediately so a timeout rejection is never
    // reported as an unhandled rejection while the send retries.
    const drainOutcome = drain.then(
      () => null,
      (error: unknown) => error,
    );

    // The send is rejected with host_restarting, then auto-retried; when the
    // drain times out admission resumes and the retry is accepted.
    await expect(
      client.sendAgentMessage(idleAgent.id, "during a short drain", {
        messageId: "auto-accept-id",
      }),
    ).resolves.toBeUndefined();

    await expect(drainOutcome).resolves.toBeInstanceOf(RestartDrainTimeoutError);
    expect(heldAgent.status).toBe("running");
  } finally {
    for (const gate of gates) gate.resolve();
    await client.close();
    await daemon.close();
  }
});

test("--wait-idle superseded by --wait-idle --force emits exactly one restart intent", async () => {
  const { agentClients, gates } = holdMatching(/hold/i);
  const daemon = await createTestPaseoDaemon({ mcpEnabled: false, agentClients });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    hostRestartAutoResend: false,
  });
  try {
    await startHeldTurn(daemon, client, "hold this turn");

    let drainingA = false;
    const drainA = client.restartServer("drain_a", undefined, {
      waitIdle: true,
      idleTimeoutMs: 5_000,
      onDrainProgress: () => {
        drainingA = true;
      },
    });
    await vi.waitFor(() => expect(drainingA).toBe(true));

    // B force-supersedes A and starts its own drain; A must not abort it while
    // cleaning up.
    const drainB = client.restartServer("drain_b_force", undefined, {
      waitIdle: true,
      idleTimeoutMs: 5_000,
      force: true,
    });

    const ackA = await drainA;
    expect(ackA.status).toBe("restart_requested");

    // Release the held turn so B's drain completes and B emits the intent.
    gates[0]!.resolve();
    const ackB = await drainB;
    expect(ackB.status).toBe("restart_requested");

    expect(daemon.daemon.agentManager.getRestartIntentCount()).toBe(1);
    expect(daemon.daemon.agentManager.hasEmittedRestartIntent()).toBe(true);
  } finally {
    for (const gate of gates) gate.resolve();
    await client.close();
    await daemon.close();
  }
});
