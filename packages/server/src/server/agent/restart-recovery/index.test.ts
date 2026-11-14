import { expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStorage, parseStoredAgentRecord } from "../agent-storage.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { createRestartRecovery } from "./index.js";

test("recovery saves intent before normalization, clears before dispatch, and resumes each agent independently", async () => {
  const root = await mkdtemp(join(tmpdir(), "restart-recovery-"));
  try {
    const storage = new AgentStorage(root, createTestLogger());
    for (const [id, lastStatus] of [
      ["broken", "running"],
      ["stuck", "running"],
      ["working", "running"],
      ["idle", "idle"],
      ["initializing", "initializing"],
    ] as const) {
      await storage.upsert(
        parseStoredAgentRecord({
          id,
          lastStatus,
          provider: "codex",
          cwd: root,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      );
    }
    const dispatched: string[] = [];
    const recovery = createRestartRecovery({
      storage,
      settings: () => ({ enabled: true, prompt: "Continue verbatim.\n" }),
      eligible: async () => true,
      dispatch: async (id, prompt) => {
        expect((await storage.get(id))?.resumeOnStartup).toBe(false);
        if (id === "broken") throw new Error("unavailable");
        if (id === "stuck") return new Promise(() => {});
        dispatched.push(id + prompt);
      },
      report: () => {},
    });
    await recovery.prepareStartup();
    expect((await storage.get("working"))?.resumeOnStartup).toBe(true);
    expect((await storage.get("working"))?.lastStatus).toBe("closed");
    recovery.resumePending();
    const running = new AbortController().signal;
    await recovery.waitForResume("broken", running);
    await recovery.waitForResume("working", running);
    await recovery.waitForResume("idle", running);
    expect(dispatched).toEqual(["workingContinue verbatim.\n"]);
    const stopped = new AbortController();
    stopped.abort();
    await expect(recovery.waitForResume("stuck", stopped.signal)).rejects.toBeDefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("opt-out consumes pending recovery and excludes archived, private, owned and archived-workspace agents", async () => {
  const root = await mkdtemp(join(tmpdir(), "restart-recovery-"));
  try {
    const storage = new AgentStorage(root, createTestLogger());
    for (const extra of [
      { id: "running" },
      { id: "archived", archivedAt: "today" },
      { id: "private", internal: true },
      { id: "owned", owner: { kind: "daemon", daemonId: "hub", executionId: "run" } },
      { id: "workspace", workspaceId: "archived" },
    ]) {
      await storage.upsert(
        parseStoredAgentRecord({
          lastStatus: "running",
          provider: "codex",
          cwd: root,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          ...extra,
        }),
      );
    }
    let enabled = true;
    const dispatched: string[] = [];
    const recovery = createRestartRecovery({
      storage,
      settings: () => ({ enabled, prompt: "Resume working." }),
      eligible: async (record) => record.workspaceId !== "archived",
      dispatch: async (id) => {
        dispatched.push(id);
      },
      report: () => {},
    });
    await recovery.captureRunningAgents();
    expect((await storage.get("running"))?.resumeOnStartup).toBe(true);
    enabled = false;
    await recovery.prepareStartup();
    enabled = true;
    recovery.resumePending();
    expect(dispatched).toEqual([]);
    expect((await storage.listAll()).every((record) => !record.resumeOnStartup)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("captureRunningAgents captures agents supplied via runningAgentIds even if their persisted status is already idle", async () => {
  const root = await mkdtemp(join(tmpdir(), "restart-recovery-"));
  try {
    const storage = new AgentStorage(root, createTestLogger());
    for (const [id, lastStatus] of [
      ["interrupted-claude", "idle"],
      ["still-running", "running"],
      ["already-idle", "idle"],
      ["archived-running", "idle"],
    ] as const) {
      await storage.upsert(
        parseStoredAgentRecord({
          id,
          lastStatus,
          provider: "claude",
          cwd: root,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          ...(id === "archived-running" ? { archivedAt: "today" } : {}),
        }),
      );
    }
    const recovery = createRestartRecovery({
      storage,
      settings: () => ({ enabled: true, prompt: "Resume working." }),
      eligible: async () => true,
      dispatch: async () => {},
      report: () => {},
    });
    await recovery.captureRunningAgents(["interrupted-claude", "archived-running"]);
    expect((await storage.get("interrupted-claude"))?.resumeOnStartup).toBe(true);
    expect((await storage.get("still-running"))?.resumeOnStartup).toBe(true);
    expect((await storage.get("already-idle"))?.resumeOnStartup).toBeFalsy();
    expect((await storage.get("archived-running"))?.resumeOnStartup).toBeFalsy();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("captureRunningAgents clears resumeOnStartup for agents in completedAgentIds", async () => {
  const root = await mkdtemp(join(tmpdir(), "restart-recovery-completed-"));
  try {
    const storage = new AgentStorage(root, createTestLogger());
    await storage.upsert(
      parseStoredAgentRecord({
        id: "completed-agent",
        lastStatus: "idle",
        provider: "claude",
        cwd: root,
        resumeOnStartup: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    const recovery = createRestartRecovery({
      storage,
      settings: () => ({ enabled: true, prompt: "Resume working." }),
      eligible: async () => true,
      dispatch: async () => {},
      report: () => {},
    });
    await recovery.captureRunningAgents([], ["completed-agent"]);
    expect((await storage.get("completed-agent"))?.resumeOnStartup).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
