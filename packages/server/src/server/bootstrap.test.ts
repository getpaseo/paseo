import { expect, test } from "vitest";

import {
  createInitialMutableDaemonConfig,
  fanOutReconciledWorkspaceUpdates,
  type PaseoDaemonConfig,
} from "./bootstrap.js";

test("initial mutable config includes complete custom provider definitions", () => {
  const config = {
    listen: "127.0.0.1:0",
    paseoHome: "/tmp/paseo-test",
    corsAllowedOrigins: [],
    staticDir: "/tmp/static",
    mcpDebug: false,
    agentClients: {},
    agentStoragePath: "/tmp/agents.json",
    providerOverrides: {
      "claude-work": {
        extends: "claude",
        label: "Claude (Work)",
        description: "Company account",
        env: { CLAUDE_CONFIG_DIR: "/work/claude" },
        command: ["claude", "--work"],
      },
    },
  } satisfies PaseoDaemonConfig;

  expect(createInitialMutableDaemonConfig(config).providers["claude-work"]).toEqual(
    config.providerOverrides["claude-work"],
  );
});

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
