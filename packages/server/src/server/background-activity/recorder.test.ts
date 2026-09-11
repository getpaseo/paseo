import { describe, it, expect, afterEach } from "vitest";
import pino from "pino";
import { AgentManager } from "../agent/agent-manager.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import { BackgroundActivityRecorder } from "./recorder.js";
import {
  generateStructuredAgentResponse,
  generateStructuredAgentResponseWithFallback,
} from "../agent/agent-response-loop.js";
import { z } from "zod";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
});
async function helper() {
  const manager = new AgentManager({
    clients: { codex: createTestAgentClient("codex") },
    logger: pino({ level: "silent" }),
  });
  const agent = await manager.createAgent(
    {
      provider: "codex",
      cwd: "/tmp",
      internal: true,
      modeId: "full-access",
      systemPrompt: "Use only the supplied input",
      model: "configured-model",
    },
    undefined,
    { workspaceId: undefined, persistSession: false },
  );
  cleanup.push(async () => {
    await manager.closeAgent(agent.id);
  });
  return { manager, agent };
}

describe("background activity recorder", () => {
  it("captures live requests and retains a reused helper transcript after cleanup", async () => {
    const { manager, agent } = await helper();
    const recorder = manager.backgroundActivity;
    let notifications = 0;
    const unsubscribe = recorder.subscribe(() => notifications++);
    const first = recorder.create({
      kind: "labels",
      title: "Labels",
      cwd: "/tmp",
      sourceAgentId: "source",
    });
    expect(recorder.snapshot().requests[0].status).toBe("queued");
    const finish = recorder.capture(manager, first, agent.id, "echo hello");
    expect(recorder.snapshot().requests[0]).toMatchObject({
      status: "running",
      attempts: [{ configuredModel: "configured-model" }],
    });
    await manager.runAgent(agent.id, "echo hello");
    finish();
    recorder.finish(first);
    const second = recorder.create({ kind: "labels", title: "Labels", cwd: "/tmp" });
    const secondFinish = recorder.capture(manager, second, agent.id, "echo again");
    await manager.runAgent(agent.id, "echo again");
    secondFinish();
    recorder.finish(second);
    await manager.closeAgent(agent.id);
    await manager.deleteAgentState(agent.id);
    const snapshot = recorder.snapshot(agent.id);
    expect(snapshot.requests).toHaveLength(2);
    expect(snapshot.conversation?.systemPrompt).toContain("Use only the supplied input");
    expect(
      snapshot.rows
        .filter((row) => row.event.type === "timeline" && row.event.item.type === "user_message")
        .map((row) => row.event.type === "timeline" && row.event.item),
    ).toMatchObject([{ text: "echo hello" }, { text: "echo again" }]);
    expect(
      snapshot.rows.some(
        (row) => row.event.type === "timeline" && row.event.item.type === "assistant_message",
      ),
    ).toBe(true);
    expect(manager.listAgents()).toEqual([]);
    expect(notifications).toBeGreaterThan(3);
    unsubscribe();
    expect(recorder.snapshot(agent.id, snapshot.rows.at(-1)!.seq).rows).toEqual([]);
  });

  it("preserves failed validation attempts and cleans up a failed helper", async () => {
    const { manager } = await helper();
    const recorder = manager.backgroundActivity;
    const request = recorder.create({ kind: "commit", title: "Commit", cwd: "/tmp" });
    await expect(
      generateStructuredAgentResponse({
        manager,
        agentConfig: { provider: "codex", cwd: "/tmp", internal: true, modeId: "full-access" },
        prompt: "Respond with exactly: invalid-json",
        schema: z.object({ message: z.string() }),
        maxRetries: 1,
        persistSession: false,
        backgroundRequestId: request,
      }),
    ).rejects.toThrow();
    recorder.finish(request, "Validation failed");
    const recorded = recorder.snapshot().requests[0];
    expect(recorded.attempts).toHaveLength(2);
    expect(recorded.attempts.every((attempt) => attempt.error)).toBe(true);
    expect(manager.getAgent(recorded.attempts[0].conversationId)).toBeNull();
    expect(recorder.snapshot(recorded.attempts[0].conversationId).rows.length).toBeGreaterThan(2);
  });

  it("evicts finished conversations before omitting an active transcript", async () => {
    const { manager, agent } = await helper();
    const recorder = new BackgroundActivityRecorder(3000);
    const first = recorder.create({ kind: "commit", title: "Commit", cwd: "/tmp" });
    const finish = recorder.capture(manager, first, agent.id, "x".repeat(1000));
    finish();
    recorder.finish(first);
    const secondAgent = await manager.createAgent(
      { provider: "codex", cwd: "/tmp", internal: true, modeId: "full-access" },
      undefined,
      { persistSession: false, workspaceId: undefined },
    );
    cleanup.push(() => manager.closeAgent(secondAgent.id));
    const second = recorder.create({ kind: "commit", title: "Commit", cwd: "/tmp" });
    const done = recorder.capture(manager, second, secondAgent.id, "y".repeat(1000));
    expect(recorder.snapshot(agent.id).conversation).toBeNull();
    expect(recorder.snapshot(secondAgent.id).conversation?.truncated).toBe(false);
    done();
    recorder.finish(second);
  });

  it("marks omitted active content without interrupting work and expires history with a new recorder", async () => {
    const { manager, agent } = await helper();
    const recorder = new BackgroundActivityRecorder(2000);
    const request = recorder.create({ kind: "commit", title: "Commit", cwd: "/tmp" });
    recorder.subscribe(() => {
      throw new Error("Broken observer");
    });
    const finish = recorder.capture(manager, request, agent.id, "x".repeat(5000));
    expect(recorder.snapshot(agent.id).conversation?.truncated).toBe(true);
    expect(recorder.snapshot().requests[0].status).toBe("running");
    finish();
    recorder.finish(request);
    expect(recorder.snapshot().requests[0].status).toBe("completed");
    expect(new BackgroundActivityRecorder().snapshot(agent.id).conversation).toBeNull();
  });

  it("retains an unavailable model attempt when fallback succeeds", async () => {
    const { manager } = await helper();
    const recorder = manager.backgroundActivity;
    const request = recorder.create({ kind: "commit", title: "Commit", cwd: "/tmp" });
    const result = await generateStructuredAgentResponseWithFallback({
      manager,
      cwd: "/tmp",
      prompt: 'Respond with exactly: {"message":"Update files"}',
      agentConfigOverrides: { internal: true, modeId: "full-access" },
      schema: z.object({ message: z.string() }),
      backgroundRequestId: request,
      providers: [
        { provider: "missing-provider", model: "unavailable-model" },
        { provider: "codex", model: "configured-model" },
      ],
    });
    recorder.finish(request);
    expect(result).toEqual({ message: "Update files" });
    expect(recorder.snapshot().requests[0]).toMatchObject({
      status: "completed",
      attempts: [
        {
          provider: "missing-provider",
          configuredModel: "unavailable-model",
          error: expect.any(String),
        },
        { provider: "codex", configuredModel: "configured-model", error: null },
      ],
    });
  });
});
