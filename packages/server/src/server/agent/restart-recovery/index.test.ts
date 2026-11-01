import { expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStorage, parseStoredAgentRecord } from "../agent-storage.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { createRestartRecovery } from "./index.js";

test("provider-owned runtimes reconnect after registrations settle without receiving a resume prompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "restart-observation-"));
  try {
    const storage = new AgentStorage(root, createTestLogger());
    for (const [id, provider, lastStatus] of [
      ["external-running", "external", "running"],
      ["external-idle", "external", "idle"],
      ["ordinary-running", "codex", "running"],
    ] as const)
      await storage.upsert(
        parseStoredAgentRecord({
          id,
          provider,
          lastStatus,
          cwd: root,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      );
    let registrationsReady = false;
    const prompted: string[] = [],
      observed: string[] = [];
    const recovery = createRestartRecovery({
      storage,
      settings: () => ({ enabled: true, prompt: "Continue" }),
      eligible: async () => true,
      policy: (record) =>
        registrationsReady && record.provider === "external" ? "observe" : "prompt",
      observe: async (id) => {
        observed.push(id);
      },
      dispatch: async (id) => {
        prompted.push(id);
      },
      report: () => {},
    });
    await recovery.prepareStartup();
    registrationsReady = true;
    await recovery.resumePending();
    for (const id of ["external-running", "external-idle", "ordinary-running"])
      await recovery.waitForResume(id, new AbortController().signal);
    expect(observed.sort()).toEqual(["external-idle", "external-running"]);
    expect(prompted).toEqual(["ordinary-running"]);
    expect((await storage.list()).map((record) => record.resumeOnStartup)).toEqual([
      false,
      false,
      false,
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("startup observation obeys disablement and skips archived, internal, and owned records", async () => {
  const root = await mkdtemp(join(tmpdir(), "restart-observation-exclusions-"));
  try {
    const storage = new AgentStorage(root, createTestLogger());
    for (const extra of [
      { id: "enabled" },
      { id: "archived", archivedAt: "today" },
      { id: "internal", internal: true },
      { id: "owned", owner: { kind: "daemon", daemonId: "hub", executionId: "run" } },
      { id: "workspace", workspaceId: "archived" },
    ]) {
      await storage.upsert(
        parseStoredAgentRecord({
          provider: "external",
          cwd: root,
          lastStatus: "idle",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          ...extra,
        }),
      );
    }
    let enabled = false;
    const observed: string[] = [],
      prompted: string[] = [];
    const make = () =>
      createRestartRecovery({
        storage,
        settings: () => ({ enabled, prompt: "Continue" }),
        eligible: async (record) => record.workspaceId !== "archived",
        policy: () => "observe",
        observe: async (id) => {
          observed.push(id);
        },
        dispatch: async (id) => {
          prompted.push(id);
        },
        report: () => {},
      });
    const disabled = make();
    await disabled.prepareStartup();
    await disabled.resumePending();
    expect(observed).toEqual([]);
    enabled = true;
    const active = make();
    await active.prepareStartup();
    await active.resumePending();
    await active.waitForResume("enabled", new AbortController().signal);
    await active.resumePending();
    expect(observed).toEqual(["enabled"]);
    expect(prompted).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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
    expect((await storage.list()).every((record) => !record.resumeOnStartup)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
