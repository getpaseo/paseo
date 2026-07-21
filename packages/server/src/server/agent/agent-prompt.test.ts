import { expect, it, test, vi } from "vitest";
import pino, { type Logger } from "pino";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import {
  formatSystemNotificationPrompt,
  isSystemInjectedEnvelope,
  sendPromptToAgent,
  setupFinishNotification,
} from "./agent-prompt.js";
import type { AgentManagerEvent, ManagedAgent } from "./agent-manager.js";

interface CapturedLogger {
  logger: Logger;
  records: Array<Record<string, unknown>>;
  nextRecord: Promise<void>;
}

function createCapturedLogger(): CapturedLogger {
  const records: Array<Record<string, unknown>> = [];
  let resolveNextRecord!: () => void;
  const nextRecord = new Promise<void>((resolve) => {
    resolveNextRecord = resolve;
  });
  const logger = pino(
    { level: "error" },
    {
      write(line: string) {
        records.push(JSON.parse(line) as Record<string, unknown>);
        resolveNextRecord();
      },
    },
  );
  return { logger, records, nextRecord };
}

interface FinishNotificationScenarioOptions {
  childLastAssistantMessage?: string | null;
  childParentAgentId?: string | null;
  requireParentOwnership?: boolean;
  parentPromptError?: Error;
  logger?: Logger;
}

interface FinishNotificationScenario {
  startWatchingChild(): void;
  finishChild(): void;
  finishChildAndReadParentPrompt(): Promise<string>;
  wasParentPrompted(): boolean;
}

function createFinishNotificationScenario(
  options?: FinishNotificationScenarioOptions,
): FinishNotificationScenario {
  let subscriber: ((event: AgentManagerEvent) => void) | null = null;
  let resolveParentPrompt: ((prompt: string) => void) | null = null;
  let parentPrompted = false;

  const childAgent: ManagedAgent = Object.create(null);
  Reflect.set(childAgent, "id", "child-agent");
  Reflect.set(childAgent, "lifecycle", "idle");
  Reflect.set(childAgent, "config", { title: "Child Agent" });

  const callerAgent: ManagedAgent = Object.create(null);
  Reflect.set(callerAgent, "id", "caller-agent");
  Reflect.set(callerAgent, "lifecycle", "idle");
  Reflect.set(callerAgent, "config", { title: "Caller Agent" });

  const agentManager: AgentManager = Object.create(AgentManager.prototype);
  Reflect.set(agentManager, "getAgent", (agentId: string) => {
    if (agentId === "child-agent") {
      return childAgent;
    }
    if (agentId === "caller-agent") {
      return callerAgent;
    }
    return null;
  });
  Reflect.set(agentManager, "subscribe", (callback: (event: AgentManagerEvent) => void) => {
    subscriber = callback;
    return () => {
      subscriber = null;
    };
  });
  Reflect.set(agentManager, "getLastAssistantMessage", async () => {
    return options?.childLastAssistantMessage ?? null;
  });
  Reflect.set(agentManager, "tryRunOutOfBand", () => false);
  Reflect.set(agentManager, "hasInFlightRun", () => Boolean(options?.parentPromptError));
  Reflect.set(agentManager, "streamAgent", (_agentId: string, prompt: string) => {
    parentPrompted = true;
    resolveParentPrompt?.(prompt);
    return (async function* noop() {})();
  });
  Reflect.set(agentManager, "replaceAgentRun", async (_agentId: string, prompt: string) => {
    resolveParentPrompt?.(prompt);
    throw options?.parentPromptError;
  });

  const agentStorage: AgentStorage = Object.create(AgentStorage.prototype);
  Reflect.set(agentStorage, "get", async (agentId: string) => {
    if (agentId === "child-agent") {
      const parentAgentId =
        options?.childParentAgentId === undefined ? "caller-agent" : options.childParentAgentId;
      return {
        title: "Child Agent",
        labels: parentAgentId ? { "paseo.parent-agent-id": parentAgentId } : {},
      };
    }
    return null;
  });

  return {
    startWatchingChild() {
      setupFinishNotification({
        agentManager,
        agentStorage,
        childAgentId: "child-agent",
        callerAgentId: "caller-agent",
        requireParentOwnership: options?.requireParentOwnership,
        logger: options?.logger ?? createTestLogger(),
      });
    },
    finishChild() {
      childAgent.lifecycle = "running";
      subscriber?.({
        type: "agent_state",
        agent: childAgent,
      });

      childAgent.lifecycle = "idle";
      subscriber?.({
        type: "agent_state",
        agent: childAgent,
      });
    },
    async finishChildAndReadParentPrompt() {
      const parentPrompt = new Promise<string>((resolve) => {
        resolveParentPrompt = resolve;
      });
      this.finishChild();

      return parentPrompt;
    },
    wasParentPrompted() {
      return parentPrompted;
    },
  };
}

test("isSystemInjectedEnvelope matches the envelope formatSystemNotificationPrompt produces", () => {
  expect(isSystemInjectedEnvelope(formatSystemNotificationPrompt("child finished"))).toBe(true);
  expect(isSystemInjectedEnvelope("hello world")).toBe(false);
});

test("sendPromptToAgent forwards the client message id as run options", async () => {
  const agent: ManagedAgent = Object.create(null);
  Reflect.set(agent, "id", "agent-1");
  Reflect.set(agent, "provider", "codex");
  Reflect.set(agent, "cwd", process.cwd());

  const streamAgentSpy = vi.fn(() => (async function* noop() {})());
  const agentManager: AgentManager = Object.create(AgentManager.prototype);
  Reflect.set(
    agentManager,
    "getAgent",
    vi.fn(() => agent),
  );
  Reflect.set(agentManager, "tryRunOutOfBand", vi.fn().mockReturnValue(false));
  Reflect.set(agentManager, "hasInFlightRun", vi.fn().mockReturnValue(false));
  Reflect.set(agentManager, "streamAgent", streamAgentSpy);

  const agentStorage: AgentStorage = Object.create(AgentStorage.prototype);
  Reflect.set(
    agentStorage,
    "get",
    vi.fn(async () => null),
  );

  await sendPromptToAgent({
    agentManager,
    agentStorage,
    agentId: "agent-1",
    prompt: "hello",
    messageId: "msg-client-1",
    runOptions: { outputSchema: { type: "object" } },
    logger: createTestLogger(),
  });

  expect(streamAgentSpy).toHaveBeenCalledWith("agent-1", "hello", {
    outputSchema: { type: "object" },
    clientMessageId: "msg-client-1",
  });
});

test("sendPromptToAgent returns structured missing-cwd error for present agents", async () => {
  const missingCwd = `/tmp/paseo-missing-agent-cwd-${Date.now()}`;
  const agent: ManagedAgent = Object.create(null);
  Reflect.set(agent, "id", "agent-missing-cwd");
  Reflect.set(agent, "provider", "codex");
  Reflect.set(agent, "cwd", missingCwd);

  const streamAgentSpy = vi.fn(() => (async function* noop() {})());
  const agentManager: AgentManager = Object.create(AgentManager.prototype);
  Reflect.set(
    agentManager,
    "getAgent",
    vi.fn(() => agent),
  );
  Reflect.set(agentManager, "tryRunOutOfBand", vi.fn().mockReturnValue(false));
  Reflect.set(agentManager, "hasInFlightRun", vi.fn().mockReturnValue(false));
  Reflect.set(agentManager, "streamAgent", streamAgentSpy);

  const agentStorage: AgentStorage = Object.create(AgentStorage.prototype);
  Reflect.set(
    agentStorage,
    "get",
    vi.fn(async () => ({
      id: "agent-missing-cwd",
      cwd: missingCwd,
      provider: "codex",
      archivedAt: null,
    })),
  );

  let caught: unknown;
  try {
    await sendPromptToAgent({
      agentManager,
      agentStorage,
      agentId: "agent-missing-cwd",
      prompt: "hello",
      logger: createTestLogger(),
    });
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(Error);
  const message = (caught as Error).message;
  expect(message).toMatch(/working directory is missing/i);
  expect(message).toMatch(/Recreate the worktree|rebind the agent cwd/i);
  expect(message).not.toMatch(/Agent not found/i);
  expect(streamAgentSpy).not.toHaveBeenCalled();
});

test("sendPromptToAgent prefers live agent cwd over a stale stored cwd", async () => {
  const liveCwd = process.cwd();
  const staleCwd = `/tmp/paseo-stale-agent-cwd-${Date.now()}`;
  const agent: ManagedAgent = Object.create(null);
  Reflect.set(agent, "id", "agent-rebound");
  Reflect.set(agent, "provider", "codex");
  Reflect.set(agent, "cwd", liveCwd);

  const streamAgentSpy = vi.fn(() => (async function* noop() {})());
  const agentManager: AgentManager = Object.create(AgentManager.prototype);
  Reflect.set(
    agentManager,
    "getAgent",
    vi.fn(() => agent),
  );
  Reflect.set(agentManager, "tryRunOutOfBand", vi.fn().mockReturnValue(false));
  Reflect.set(agentManager, "hasInFlightRun", vi.fn().mockReturnValue(false));
  Reflect.set(agentManager, "streamAgent", streamAgentSpy);

  const agentStorage: AgentStorage = Object.create(AgentStorage.prototype);
  Reflect.set(
    agentStorage,
    "get",
    vi.fn(async () => ({
      id: "agent-rebound",
      cwd: staleCwd,
      provider: "codex",
      archivedAt: null,
    })),
  );

  // Live resident cwd is valid; stored path is gone. Send must succeed using live cwd.
  await sendPromptToAgent({
    agentManager,
    agentStorage,
    agentId: "agent-rebound",
    prompt: "hello",
    logger: createTestLogger(),
  });

  expect(streamAgentSpy).toHaveBeenCalledTimes(1);
  expect(streamAgentSpy).toHaveBeenCalledWith("agent-rebound", "hello", undefined);

  // Control: if only the stale stored path were used, send would reject.
  Reflect.set(
    agentManager,
    "getAgent",
    vi.fn(() => null),
  );
  await expect(
    sendPromptToAgent({
      agentManager,
      agentStorage,
      agentId: "agent-rebound",
      prompt: "hello-stale-only",
      logger: createTestLogger(),
    }),
  ).rejects.toSatisfy((error: unknown) => {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/working directory is missing/i);
    return true;
  });
  expect(streamAgentSpy).toHaveBeenCalledTimes(1);
});

test("sendPromptToAgent returns structured error when cwd ancestor is a file (ENOTDIR)", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "paseo-send-enotdir-"));
  const fileAncestor = join(dir, "not-a-dir");
  writeFileSync(fileAncestor, "x");
  const enotdirCwd = join(fileAncestor, "worktree");

  try {
    const agent: ManagedAgent = Object.create(null);
    Reflect.set(agent, "id", "agent-file-ancestor");
    Reflect.set(agent, "provider", "codex");
    Reflect.set(agent, "cwd", enotdirCwd);

    const streamAgentSpy = vi.fn(() => (async function* noop() {})());
    const agentManager: AgentManager = Object.create(AgentManager.prototype);
    Reflect.set(
      agentManager,
      "getAgent",
      vi.fn(() => agent),
    );
    Reflect.set(agentManager, "tryRunOutOfBand", vi.fn().mockReturnValue(false));
    Reflect.set(agentManager, "hasInFlightRun", vi.fn().mockReturnValue(false));
    Reflect.set(agentManager, "streamAgent", streamAgentSpy);

    const agentStorage: AgentStorage = Object.create(AgentStorage.prototype);
    Reflect.set(
      agentStorage,
      "get",
      vi.fn(async () => ({
        id: "agent-file-ancestor",
        cwd: enotdirCwd,
        provider: "codex",
        archivedAt: null,
      })),
    );

    await expect(
      sendPromptToAgent({
        agentManager,
        agentStorage,
        agentId: "agent-file-ancestor",
        prompt: "hello",
        logger: createTestLogger(),
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toMatch(/working directory is missing/i);
      expect(message).toMatch(/Recreate the worktree|rebind the agent cwd/i);
      expect(message).not.toMatch(/\bAgent not found\b/i);
      expect(message).not.toMatch(/\bENOTDIR\b|\bENOENT\b/);
      return true;
    });
    expect(streamAgentSpy).not.toHaveBeenCalled();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("finish notifications tell the parent the child's last assistant message", async () => {
  const scenario = createFinishNotificationScenario({
    childLastAssistantMessage: "Implemented the cleanup and all checks pass.",
  });

  scenario.startWatchingChild();
  const parentPrompt = await scenario.finishChildAndReadParentPrompt();

  expect(parentPrompt).toEqual(
    formatSystemNotificationPrompt(
      "Agent child-agent (Child Agent) finished.\n\n<agent-response>\nImplemented the cleanup and all checks pass.\n</agent-response>",
    ),
  );
});

test("detaching a child ends its parent-owned finish notification", async () => {
  const scenario = createFinishNotificationScenario({
    childParentAgentId: null,
    requireParentOwnership: true,
  });
  scenario.startWatchingChild();
  scenario.finishChild();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(scenario.wasParentPrompted()).toBe(false);
});

test("follow-up finish notifications do not require a parent relationship", async () => {
  const scenario = createFinishNotificationScenario({ childParentAgentId: "another-agent" });

  scenario.startWatchingChild();
  const parentPrompt = await scenario.finishChildAndReadParentPrompt();

  expect(parentPrompt).toContain("Agent child-agent (Child Agent) finished.");
});

test("finish notifications log a rejected parent prompt without an unhandled rejection", async () => {
  const captured = createCapturedLogger();
  const scenario = createFinishNotificationScenario({
    parentPromptError: new Error("parent provider rejected replacement"),
    logger: captured.logger,
  });

  scenario.startWatchingChild();
  await scenario.finishChildAndReadParentPrompt();
  await captured.nextRecord;

  expect(captured.records).toEqual([
    expect.objectContaining({
      msg: "Failed to notify caller agent",
      childAgentId: "child-agent",
      callerAgentId: "caller-agent",
      reason: "finished",
      err: expect.objectContaining({ message: "parent provider rejected replacement" }),
    }),
  ]);
});

it("does not notify archived callers", async () => {
  let subscriber: ((event: AgentManagerEvent) => void) | null = null;

  const childAgent: ManagedAgent = Object.create(null);
  Reflect.set(childAgent, "id", "child-agent");
  Reflect.set(childAgent, "lifecycle", "idle");
  Reflect.set(childAgent, "config", { title: "Child Agent" });

  const callerAgent: ManagedAgent = Object.create(null);
  Reflect.set(callerAgent, "id", "caller-agent");
  Reflect.set(callerAgent, "lifecycle", "idle");
  Reflect.set(callerAgent, "config", { title: "Caller Agent" });

  const streamAgentSpy = vi.fn(() => (async function* noop() {})());
  const replaceAgentRunSpy = vi.fn(() => (async function* noop() {})());

  const agentManager: AgentManager = Object.create(AgentManager.prototype);
  Reflect.set(
    agentManager,
    "getAgent",
    vi.fn((agentId: string) => {
      if (agentId === "child-agent") {
        return childAgent;
      }
      if (agentId === "caller-agent") {
        return callerAgent;
      }
      return null;
    }),
  );
  Reflect.set(
    agentManager,
    "subscribe",
    vi.fn((callback: (event: AgentManagerEvent) => void) => {
      subscriber = callback;
      return () => {
        subscriber = null;
      };
    }),
  );
  Reflect.set(agentManager, "hasInFlightRun", vi.fn().mockReturnValue(false));
  Reflect.set(agentManager, "streamAgent", streamAgentSpy);
  Reflect.set(agentManager, "replaceAgentRun", replaceAgentRunSpy);

  const agentStorageGetSpy = vi.fn(async (agentId: string) =>
    agentId === "caller-agent" ? { archivedAt: "2024-01-01" } : null,
  );
  const agentStorage: AgentStorage = Object.create(AgentStorage.prototype);
  Reflect.set(agentStorage, "get", agentStorageGetSpy);

  setupFinishNotification({
    agentManager,
    agentStorage,
    childAgentId: "child-agent",
    callerAgentId: "caller-agent",
    logger: createTestLogger(),
  });

  expect(subscriber).not.toBeNull();

  childAgent.lifecycle = "running";
  subscriber?.({
    type: "agent_state",
    agent: childAgent,
  });

  childAgent.lifecycle = "idle";
  subscriber?.({
    type: "agent_state",
    agent: childAgent,
  });

  await vi.waitFor(() => {
    expect(agentStorageGetSpy).toHaveBeenCalledWith("caller-agent");
  });

  expect(streamAgentSpy).not.toHaveBeenCalled();
  expect(replaceAgentRunSpy).not.toHaveBeenCalled();
});
