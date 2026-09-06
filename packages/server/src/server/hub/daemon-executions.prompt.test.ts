import { expect, test } from "vitest";

import type { AgentStorage, StoredAgentRecord } from "../agent/agent-storage.js";
import type { AgentManager } from "../agent/agent-manager.js";
import { DaemonExecutions } from "./daemon-executions.js";

const DAEMON_ID = "daemon-1";
const EXECUTION_ID = "execution-1";

function executionsFor(record: StoredAgentRecord | undefined): {
  executions: DaemonExecutions;
  prompted: Array<{ agentId: string; prompt: string; activeTurnBehavior?: string }>;
} {
  const prompted: Array<{ agentId: string; prompt: string; activeTurnBehavior?: string }> = [];
  const executions = new DaemonExecutions({
    daemonId: DAEMON_ID,
    agentManager: { subscribe: () => () => undefined } as unknown as AgentManager,
    agentStorage: {
      findByDaemonExecution: async () => record,
    } as unknown as AgentStorage,
    createAgent: (async () => {
      throw new Error("not used");
    }) as never,
    interruptAgent: async () => undefined,
    promptAgent: async (input) => {
      prompted.push(input);
      return { disposition: "steered" as const };
    },
    archiveWorkspace: async () => undefined,
  });
  return { executions, prompted };
}

function agentRecord(overrides: Partial<StoredAgentRecord> = {}): StoredAgentRecord {
  return {
    id: "agent-1",
    workspaceId: "workspace-1",
    archivedAt: null,
    owner: { kind: "daemon", daemonId: DAEMON_ID, executionId: EXECUTION_ID },
    ...overrides,
  } as StoredAgentRecord;
}

test("delivers a Hub prompt to the agent this execution owns", async () => {
  const { executions, prompted } = executionsFor(agentRecord());

  const result = await executions.prompt({
    executionId: EXECUTION_ID,
    prompt: "and now fix the loader",
    activeTurnBehavior: "steer",
  });

  expect(result).toEqual({ delivered: true, disposition: "steered" });
  expect(prompted).toEqual([
    { agentId: "agent-1", prompt: "and now fix the loader", activeTurnBehavior: "steer" },
  ]);
});

test("reports an archived agent as undelivered so the caller starts a fresh one", async () => {
  const { executions, prompted } = executionsFor(agentRecord({ archivedAt: new Date() }));

  const result = await executions.prompt({ executionId: EXECUTION_ID, prompt: "hello" });

  expect(result).toEqual({ delivered: false, disposition: null });
  expect(prompted).toEqual([]);
});

test("reports an unknown execution as undelivered", async () => {
  const { executions, prompted } = executionsFor(undefined);

  const result = await executions.prompt({ executionId: EXECUTION_ID, prompt: "hello" });

  expect(result).toEqual({ delivered: false, disposition: null });
  expect(prompted).toEqual([]);
});

test("refuses to prompt once the Hub relationship authority ended", async () => {
  const { executions } = executionsFor(agentRecord());
  await executions.invalidateAuthority();

  await expect(executions.prompt({ executionId: EXECUTION_ID, prompt: "hello" })).rejects.toThrow(
    /authority is no longer active/u,
  );
});
