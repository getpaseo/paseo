import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, onTestFinished } from "vitest";
import { MutableDaemonConfigSchema } from "@getpaseo/protocol/messages";
import { DaemonConfigStore } from "./daemon-config-store.js";
import { loadPersistedConfig } from "./persisted-config.js";
import {
  createIdleRuntimeCleanup,
  type RuntimeCleanupCandidate,
} from "./agent/idle-runtime-cleanup/index.js";
import { createTestLogger } from "../test-utils/test-logger.js";

import { fanOutReconciledWorkspaceUpdates, connectIdleRuntimeCleanupConfig } from "./bootstrap.js";

test("reconciliation emits workspace updates when observer sync fails", async () => {
  const emittedWorkspaceIds: string[][] = [];
  const syncFailure = new Error("workspace observer unavailable");

  await fanOutReconciledWorkspaceUpdates({
    sessions: [
      {
        syncWorkspaceGitObserversForExternalWorkspaceIds: async () => {
          throw syncFailure;
        },
        emitWorkspaceUpdatesForExternalWorkspaceIds: async (workspaceIds) => {
          emittedWorkspaceIds.push(Array.from(workspaceIds));
        },
      },
    ],
    workspaceIds: ["ws-reclassified"],
    logger: { warn: () => {} },
  });

  expect(emittedWorkspaceIds).toEqual([["ws-reclassified"]]);
});

test("reconciliation isolates workspace update failures between sessions", async () => {
  const emittedWorkspaceIds: string[][] = [];
  const warnings: unknown[] = [];

  await fanOutReconciledWorkspaceUpdates({
    sessions: [
      {
        syncWorkspaceGitObserversForExternalWorkspaceIds: async () => {},
        emitWorkspaceUpdatesForExternalWorkspaceIds: async () => {
          throw new Error("session closed");
        },
      },
      {
        syncWorkspaceGitObserversForExternalWorkspaceIds: async () => {},
        emitWorkspaceUpdatesForExternalWorkspaceIds: async (workspaceIds) => {
          emittedWorkspaceIds.push(Array.from(workspaceIds));
        },
      },
    ],
    workspaceIds: ["ws-reclassified"],
    logger: {
      warn: (context) => {
        warnings.push(context);
      },
    },
  });

  expect(emittedWorkspaceIds).toEqual([["ws-reclassified"]]);
  expect(warnings).toHaveLength(1);
});

// Exercise bootstrap's actual live-config binding with the real collector and store.

function liveCleanupHost() {
  const home = mkdtempSync(path.join(tmpdir(), "paseo-live-cleanup-"));
  writeFileSync(path.join(home, "config.json"), JSON.stringify({ version: 1 }));
  const store = new DaemonConfigStore(
    home,
    MutableDaemonConfigSchema.parse({
      relay: { enabled: true },
      mcp: { injectIntoAgents: false },
      idleRuntimeCleanup: true,
    }),
    undefined,
    {
      reloadSource: {
        resolve: (persisted) => ({
          mutable: MutableDaemonConfigSchema.parse({
            relay: { enabled: true },
            mcp: { injectIntoAgents: false },
            idleRuntimeCleanup: persisted.agents?.idleRuntimeCleanup ?? true,
          }),
          overrideControlledPaths: [],
        }),
      },
    },
  );
  let minutes = 61;
  let closed = false;
  let protectedCaller = false;
  const runtime: RuntimeCleanupCandidate = {
    identity: {},
    agentId: "agent",
    provider: "test",
    sessionId: "session",
    parentAgentId: undefined,
    lastActivityAt: 0,
    isEligible: () => !closed,
    closeIfEligible: async (eligible) => {
      if (!eligible()) return false;
      closed = true;
      return true;
    },
  };
  const cleanup = createIdleRuntimeCleanup({
    enabled: true,
    now: () => minutes * 60_000,
    runtimes: () => [runtime],
    isProtected: () => protectedCaller,
    logger: createTestLogger(),
    schedule: () => () => {},
  });
  const unsubscribe = connectIdleRuntimeCleanupConfig(store, cleanup);
  onTestFinished(async () => {
    unsubscribe();
    await cleanup.close();
    rmSync(home, { recursive: true, force: true });
  });
  return {
    home,
    store,
    cleanup,
    unsubscribe,
    protect: (value: boolean) => {
      protectedCaller = value;
    },
    sweep: (at = minutes) => {
      minutes = at;
      return cleanup.sweep();
    },
  };
}

test("bootstrap's host toggle prevents collection live, persists, and leaves other hosts enabled", async () => {
  const host = liveCleanupHost();
  const other = liveCleanupHost();
  host.store.patch({ idleRuntimeCleanup: false });
  expect(loadPersistedConfig(host.home).agents?.idleRuntimeCleanup).toBe(false);
  expect((await host.sweep()).collected).toEqual([]);
  expect((await other.sweep()).collected).toHaveLength(1);
  host.store.patch({ idleRuntimeCleanup: true });
  host.protect(true);
  expect((await host.sweep()).collected).toEqual([]);
  host.protect(false);
  expect((await host.sweep(62)).collected).toEqual([]);
  expect((await host.sweep(122)).collected).toHaveLength(1);
});

test("bootstrap's config-file reload binding disables and enables eligible collection live", async () => {
  const host = liveCleanupHost();
  for (const enabled of [false, true]) {
    writeFileSync(
      path.join(host.home, "config.json"),
      JSON.stringify({ version: 1, agents: { idleRuntimeCleanup: enabled } }),
    );
    expect(host.store.reload()).toEqual({
      appliedPaths: ["agents.idleRuntimeCleanup"],
      restartRequiredPaths: [],
      overrideControlledPaths: [],
    });
    expect((await host.sweep()).collected).toHaveLength(enabled ? 1 : 0);
  }
});

test.each([false, true])(
  "failed config apply restores prior idle cleanup behavior (previous: %s)",
  async (previous) => {
    const host = liveCleanupHost();
    host.store.patch({ idleRuntimeCleanup: previous });
    const persistedBefore = loadPersistedConfig(host.home);
    const refuse = host.store.onApply(() => {
      throw new Error("Another live owner refused");
    });
    expect(() => host.store.patch({ idleRuntimeCleanup: !previous })).toThrow(
      "Another live owner refused",
    );
    expect(host.store.get().idleRuntimeCleanup).toBe(previous);
    expect(loadPersistedConfig(host.home)).toEqual(persistedBefore);
    expect((await host.sweep()).collected).toHaveLength(previous ? 1 : 0);
    refuse();
  },
);

test("disposing bootstrap's binding stops configuration delivery", async () => {
  const host = liveCleanupHost();
  host.unsubscribe();
  host.store.patch({ idleRuntimeCleanup: false });
  expect((await host.sweep()).collected).toHaveLength(1);
});
