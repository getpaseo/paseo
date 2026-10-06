// Shared harness for the Claude Plan tests: a typed fake query and a session factory.
import type {
  CanUseTool,
  PermissionMode,
  PermissionResult,
  Query,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { createTestLogger } from "../../../../../test-utils/test-logger.js";
import type {
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
} from "../../../agent-sdk-types.js";
import { ClaudeAgentClient } from "../agent.js";
import type { ClaudeQueryInput } from "../query.js";

export interface PermissionModeHold {
  /** Resolves once the held setPermissionMode call has started. */
  reached: Promise<void>;
  release(): void;
}

export interface FakeClaudeQuery {
  query: Query;
  permissionModes: PermissionMode[];
  /** Makes the next setPermissionMode call fail the way a dead Claude process does. */
  failNextPermissionMode(message: string): void;
  emit(message: SDKMessage): void;
  /** Ends the stream before a result, the way it ends when the Claude Code process dies. */
  end(): void;
  /** Whether the session closed this query. */
  isClosed(): boolean;
  /** Makes the next setPermissionMode call wait, the way a busy Claude Code process answers late. */
  holdNextPermissionMode(): PermissionModeHold;
}

export function createFakeClaudeQuery(): FakeClaudeQuery {
  const permissionModes: PermissionMode[] = [];
  let permissionModeFailure: string | null = null;
  let permissionModeHold: { reached(): void; released: Promise<void> } | null = null;
  const pending: SDKMessage[] = [];
  const waiters: Array<(result: IteratorResult<SDKMessage, void>) => void> = [];
  let ended = false;
  let closed = false;
  const finish = () => {
    ended = true;
    for (const waiter of waiters.splice(0)) waiter({ value: undefined, done: true });
  };
  const fake = {
    async setPermissionMode(mode: PermissionMode) {
      if (permissionModeFailure) {
        const message = permissionModeFailure;
        permissionModeFailure = null;
        throw new Error(message);
      }
      permissionModes.push(mode);
      const hold = permissionModeHold;
      permissionModeHold = null;
      if (hold) {
        hold.reached();
        await hold.released;
      }
    },
    async applyFlagSettings() {},
    async setModel() {},
    async getContextUsage() {
      return undefined;
    },
    async supportedCommands() {
      return [];
    },
    async supportedModels() {
      return [];
    },
    async interrupt() {},
    close() {
      closed = true;
      finish();
    },
    async return() {
      closed = true;
      finish();
      return { value: undefined, done: true };
    },
    next(): Promise<IteratorResult<SDKMessage, void>> {
      const message = pending.shift();
      if (message) return Promise.resolve({ value: message, done: false });
      if (ended) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve) => waiters.push(resolve));
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  return {
    query: fake as unknown as Query,
    permissionModes,
    failNextPermissionMode(message) {
      permissionModeFailure = message;
    },
    emit(message) {
      const waiter = waiters.shift();
      if (waiter) waiter({ value: message, done: false });
      else pending.push(message);
    },
    end: finish,
    isClosed: () => closed,
    holdNextPermissionMode() {
      let release = () => {};
      let markReached = () => {};
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const reached = new Promise<void>((resolve) => {
        markReached = resolve;
      });
      permissionModeHold = { reached: markReached, released };
      return { reached, release };
    },
  };
}

export interface PlanSessionHarness {
  session: AgentSession;
  launches: ClaudeQueryInput[];
  queries: FakeClaudeQuery[];
  events: AgentStreamEvent[];
  canUseTool(): CanUseTool;
}

const sessions: AgentSession[] = [];

/** Closes every session the tests in this file opened; call it from afterEach. */
export async function closePlanSessions(): Promise<void> {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
}

/** Tracks a session a test created outside createPlanSession, so closePlanSessions closes it. */
export function trackPlanSession(session: AgentSession): void {
  sessions.push(session);
}

/** Claude Code talking to the Anthropic API, where it offers Auto mode. */
export const ANTHROPIC_API_ENV = { CLAUDE_CODE_USE_BEDROCK: "0", CLAUDE_CODE_USE_VERTEX: "0" };
/** Claude Code on Bedrock, where Auto mode does not exist. */
export const BEDROCK_ENV = { CLAUDE_CODE_USE_BEDROCK: "1" };

export async function createPlanSession(
  config: Partial<AgentSessionConfig> = {},
  options: { env?: Record<string, string> } = {},
): Promise<PlanSessionHarness> {
  const launches: ClaudeQueryInput[] = [];
  const queries: FakeClaudeQuery[] = [];
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    resolveBinary: async () => "/test/claude/bin",
    runtimeSettings: options.env ? { env: options.env } : undefined,
    queryFactory: (input) => {
      launches.push(input);
      const fake = createFakeClaudeQuery();
      queries.push(fake);
      return fake.query;
    },
  });
  const session = await client.createSession({ provider: "claude", cwd: process.cwd(), ...config });
  sessions.push(session);
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  return {
    session,
    launches,
    queries,
    events,
    canUseTool() {
      const callback = launches.at(-1)?.options.canUseTool;
      if (!callback) throw new Error("Expected the Claude query to receive canUseTool");
      return callback;
    },
  };
}

export function toolCallOptions(toolUseID: string): Parameters<CanUseTool>[2] {
  return { signal: new AbortController().signal, toolUseID, requestId: `request-${toolUseID}` };
}

export function permissionRequests(events: AgentStreamEvent[]) {
  return events.filter((event) => event.type === "permission_requested");
}

export type CallbackOutcome =
  | { settled: true; result: PermissionResult | null }
  | { settled: false }
  | { rejected: string };

export async function letThePumpRun(): Promise<void> {
  for (let tick = 0; tick < 10; tick += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** A callback that waits for a person never settles on its own; one Paseo answers settles at once. */
export async function settledOutcome(
  callback: Promise<PermissionResult | null>,
): Promise<CallbackOutcome> {
  const settled = callback.then(
    (result): CallbackOutcome => ({ settled: true, result }),
    (error: unknown): CallbackOutcome => ({
      rejected: error instanceof Error ? error.message : String(error),
    }),
  );
  const stillWaiting = new Promise<CallbackOutcome>((resolve) =>
    setImmediate(() => resolve({ settled: false })),
  );
  return Promise.race([settled, stillWaiting]);
}
