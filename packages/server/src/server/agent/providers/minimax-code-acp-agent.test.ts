import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { AgentSession, AgentStreamEvent } from "../agent-sdk-types.js";
import { buildProviderRegistry } from "../provider-registry.js";
import { createEventCollector, type EventCollector } from "./test-utils/event-collector.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { GenericACPAgentClient } from "./generic-acp-agent.js";
import { isMiniMaxCodeProvider, MiniMaxCodeACPAgentClient } from "./minimax-code-acp-agent.js";

/**
 * The command the ACP catalog ships for MiniMax Code.
 */
const CATALOG_COMMAND = ["npx", "-y", "-p", "@minimax-ai/code@0.6.13", "mcode", "acp"];

/**
 * The command the ACP catalog ships for DimCode, whose name contains the
 * MiniMax binary name.
 */
const DIMCODE_COMMAND = ["npx", "-y", "dimcode@0.5.21", "acp"];

/**
 * How long a row waits before the track shows a child the provider reported
 * as finished before it started.
 */
const DELEGATION_CONFIRMATION_MS = 500;

describe("isMiniMaxCodeProvider", () => {
  test("recognizes the provider id", () => {
    expect(isMiniMaxCodeProvider("minimax-code", undefined)).toBe(true);
  });

  test("recognizes the command the catalog ships", () => {
    expect(isMiniMaxCodeProvider(undefined, CATALOG_COMMAND)).toBe(true);
    expect(isMiniMaxCodeProvider("my-agent", CATALOG_COMMAND)).toBe(true);
  });

  test("recognizes the binary name on its own", () => {
    expect(isMiniMaxCodeProvider(undefined, ["mcode", "acp"])).toBe(true);
    expect(isMiniMaxCodeProvider(undefined, ["/usr/local/bin/mcode", "acp"])).toBe(true);
  });

  test("recognizes a Windows launcher", () => {
    expect(isMiniMaxCodeProvider(undefined, ["mcode.cmd", "acp"])).toBe(true);
    expect(isMiniMaxCodeProvider(undefined, ["C:\\tools\\mcode.cmd", "acp"])).toBe(true);
    expect(isMiniMaxCodeProvider("my-agent", ["C:\\tools\\mcode.cmd", "acp"])).toBe(true);
  });

  test("leaves DimCode alone", () => {
    expect(isMiniMaxCodeProvider(undefined, DIMCODE_COMMAND)).toBe(false);
    expect(isMiniMaxCodeProvider("dimcode", DIMCODE_COMMAND)).toBe(false);
    expect(isMiniMaxCodeProvider(undefined, ["dimcode", "acp"])).toBe(false);
  });

  test("leaves another Windows launcher alone", () => {
    expect(isMiniMaxCodeProvider(undefined, ["dimcode.cmd", "acp"])).toBe(false);
    expect(isMiniMaxCodeProvider(undefined, ["C:\\tools\\mcode-helper.cmd", "acp"])).toBe(false);
  });

  test("leaves another ACP provider alone", () => {
    expect(isMiniMaxCodeProvider("claude", ["/usr/local/bin/claude", "--acp"])).toBe(false);
    expect(isMiniMaxCodeProvider("kimi", ["kimi", "acp"])).toBe(false);
    expect(isMiniMaxCodeProvider(undefined, undefined)).toBe(false);
  });
});

const MINIMAX_CODE_ACP_AGENT = `
import { appendFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
const { AgentSideConnection, PROTOCOL_VERSION, ndJsonStream } = await import(process.env.ACP_SDK_URL);

const log = (entry) => appendFileSync(process.env.ACP_TEST_LOG, JSON.stringify(entry) + "\\n");

const member = (sessionId, parentSessionId, agentName, task, status, createdAtMs, updatedAtMs) => ({
  sessionId,
  parentSessionId,
  agentName,
  task,
  status,
  createdAtMs,
  updatedAtMs,
});

const scenario = process.env.ACP_DELEGATION_SCENARIO ?? "tree";
const tree = {
  schemaVersion: 1,
  rootSessionId: "root-session",
  members: [
    member("child-session", "root-session", "explore", "List files in working directory", "running", 1000, 2000),
    member("grandchild-session", "child-session", "worker", "Summarize the findings", "completed", 1000, 3000),
    member("instant-session", "root-session", "worker", "Finish in a moment", "completed", 4000, 4000),
    member("queued-session", "root-session", "worker", "Wait in the queue", "queued", 5000, 5000),
    member("unknown-session", "root-session", "worker", "Report something new", "nonsense", 5500, 5500),
    member("failed-session", "root-session", "worker", "Fail the search", "failed", 6000, 6500),
    member("stopped-session", "root-session", "worker", "Stop the search", "stopped", 7000, 7500),
  ],
};
// A tree whose children hang under parents the track cannot show: a parent
// Paseo has no state for, and a parent the tree does not hold at all.
const hiddenParentTree = {
  schemaVersion: 1,
  rootSessionId: "root-session",
  members: [
    member("child-session", "root-session", "explore", "List files in working directory", "running", 1000, 2000),
    member("queued-parent", "child-session", "worker", "Wait in the queue", "queued", 1500, 1500),
    member("queued-child", "queued-parent", "worker", "Report under a hidden parent", "running", 1600, 1700),
    member("orphan-child", "missing-parent", "worker", "Report under a missing parent", "running", 1800, 1900),
  ],
};
// A child the provider publishes as finished at the moment it creates it.
const lateMember = member("late-session", "root-session", "worker", "Start late", "completed", 8000, 8000);
const lateRunning = member("late-session", "root-session", "worker", "Start late", "running", 8000, 8200);
const withLate = { ...tree, members: [...tree.members, lateMember] };
const withLateRunning = { ...tree, members: [...tree.members, lateRunning] };
// The provider answers the read with a tree that reports a child as finished,
// and publishes the same child as running again a moment later.
const regressedTree = {
  ...tree,
  members: tree.members.map((entry) =>
    entry.sessionId === "grandchild-session" ? { ...entry, status: "running" } : entry,
  ),
};

let promptCount = 0;

new AgentSideConnection(
  (connection) => ({
    async initialize(params) {
      log({ method: "initialize", clientCapabilities: params.clientCapabilities });
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: { loadSession: true },
        _meta: {
          "minimax-code/extensions": {
            version: 1,
            methods: ["mcode/session/delegation/get"],
            notifications: ["mcode/session/delegation_update"],
          },
        },
      };
    },
    async newSession() {
      return { sessionId: "minimax-session" };
    },
    async loadSession() {
      return {};
    },
    async extMethod(method, params) {
      log({ method, params });
      return { snapshot: scenario === "hidden-parent" ? hiddenParentTree : tree };
    },
    async prompt() {
      promptCount += 1;
      if (scenario === "regress") {
        await connection.extNotification("mcode/session/delegation_update", {
          sessionId: "minimax-session",
          snapshot: regressedTree,
        });
        return { stopReason: "end_turn" };
      }
      if (scenario === "repeat") {
        // The provider reports the same child as finished again and again,
        // while the tree it publishes changes around it.
        await connection.extNotification("mcode/session/delegation_update", {
          sessionId: "minimax-session",
          snapshot: {
            ...withLate,
            members: [
              ...withLate.members,
              member("churn-" + promptCount, "root-session", "worker", "Churn " + promptCount, "running", 9000, 9000),
            ],
          },
        });
        return { stopReason: "end_turn" };
      }
      if (scenario === "confirm") {
        // The provider reports the child as finished, and takes it back on the
        // turn that follows.
        const snapshot = promptCount === 1 ? withLate : withLateRunning;
        await connection.extNotification("mcode/session/delegation_update", {
          sessionId: "minimax-session",
          snapshot,
        });
        return { stopReason: "end_turn" };
      }
      await connection.extNotification("mcode/session/delegation_update", {
        sessionId: "minimax-session",
        snapshot: tree,
      });
      return { stopReason: "end_turn" };
    },
    async authenticate() {},
    async cancel() {},
  }),
  ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
);
`;

describe("MiniMaxCodeACPAgentClient", () => {
  let dir: string;
  let agentScript: string;
  let logPath: string;
  let session: AgentSession | null = null;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "paseo-minimax-code-"));
    agentScript = path.join(dir, "agent.mjs");
    logPath = path.join(dir, "agent.log");
    await writeFile(agentScript, MINIMAX_CODE_ACP_AGENT);
  });

  afterEach(async () => {
    await session?.close();
    session = null;
    vi.useRealTimers();
    await rm(dir, { recursive: true, force: true });
  });

  function createClient(options: { scenario?: string } = {}) {
    return new MiniMaxCodeACPAgentClient({
      logger: createTestLogger(),
      command: [process.execPath, agentScript],
      providerId: "minimax-code",
      env: {
        ACP_SDK_URL: pathToFileURL(
          createRequire(import.meta.url).resolve("@agentclientprotocol/sdk"),
        ).href,
        ACP_TEST_LOG: logPath,
        ACP_DELEGATION_SCENARIO: options.scenario ?? "tree",
      },
    });
  }

  async function readAgentLog(): Promise<Array<Record<string, unknown>>> {
    const raw = await readFile(logPath, "utf8");
    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  function delegationRows(events: AgentStreamEvent[]): Array<Record<string, unknown>> {
    return events
      .filter((event) => event.type === "provider_subagent")
      .map((event) => {
        const input = (event as { event: Record<string, unknown> }).event;
        return {
          id: input.id,
          title: input.title,
          description: input.description,
          status: input.status,
          parentSubagentId: input.parentSubagentId,
        };
      });
  }

  function rowsFor(events: AgentStreamEvent[], id: string): Array<Record<string, unknown>> {
    return delegationRows(events).filter((row) => row.id === id);
  }

  /**
   * Runs a turn and waits for it to end.
   *
   * The provider publishes its tree before it answers the prompt, and the
   * session publishes the rows of that tree before it reports the end of the
   * turn. Waiting for the end of the turn therefore waits for the rows too.
   */
  async function runTurn(
    target: AgentSession,
    collector: EventCollector,
    prompt: string,
  ): Promise<void> {
    const from = collector.events.length;
    await target.startTurn(prompt);
    await collector.waitFor((event) => event.type === "turn_completed", from);
  }

  /**
   * Hands the clock to the test.
   *
   * A child the provider reports as finished before it started waits before
   * the track shows it. The wait is a timer, so a test that says when the
   * deadline passes needs the clock in its hands.
   */
  function useControlledClock(): void {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  }

  test("asks a MiniMax Code command for the extension notifications", async () => {
    const registry = buildProviderRegistry(createTestLogger(), {
      providerOverrides: {
        "my-agent": {
          extends: "acp",
          label: "My Agent",
          command: [process.execPath, agentScript, "mcode", "acp"],
          env: {
            ACP_SDK_URL: pathToFileURL(
              createRequire(import.meta.url).resolve("@agentclientprotocol/sdk"),
            ).href,
            ACP_TEST_LOG: logPath,
          },
        },
      },
    });

    const client = registry["my-agent"].createClient(createTestLogger());
    session = await client.createSession({ provider: "my-agent", cwd: dir });

    const log = await readAgentLog();
    const initialize = log.find((entry) => entry.method === "initialize");
    const capabilities = initialize?.clientCapabilities as
      | { _meta?: Record<string, unknown> }
      | undefined;
    expect(capabilities?._meta).toEqual({
      "minimax-code/extensions": { version: 1, notifications: true },
    });
  });

  test("keeps DimCode on the generic ACP client", async () => {
    const registry = buildProviderRegistry(createTestLogger(), {
      providerOverrides: {
        dimcode: {
          extends: "acp",
          label: "DimCode",
          command: [process.execPath, agentScript, "dimcode", "acp"],
          env: {
            ACP_SDK_URL: pathToFileURL(
              createRequire(import.meta.url).resolve("@agentclientprotocol/sdk"),
            ).href,
            ACP_TEST_LOG: logPath,
          },
        },
      },
    });

    const client = registry["dimcode"].createClient(createTestLogger());
    session = await client.createSession({ provider: "dimcode", cwd: dir });

    const log = await readAgentLog();
    const initialize = log.find((entry) => entry.method === "initialize");
    const capabilities = initialize?.clientCapabilities as
      | { _meta?: Record<string, unknown> }
      | undefined;
    expect(capabilities?._meta).toBeUndefined();
  });

  test("asks the provider for its extension notifications in the handshake", async () => {
    const client = createClient();

    session = await client.createSession({ provider: "acp", cwd: dir });

    const log = await readAgentLog();
    const initialize = log.find((entry) => entry.method === "initialize");
    const capabilities = initialize?.clientCapabilities as
      | { _meta?: Record<string, unknown> }
      | undefined;
    expect(capabilities?._meta).toEqual({
      "minimax-code/extensions": { version: 1, notifications: true },
    });
  });

  test("merges the metadata of the caller into the handshake", async () => {
    const client = new MiniMaxCodeACPAgentClient({
      logger: createTestLogger(),
      command: [process.execPath, agentScript],
      providerId: "minimax-code",
      clientCapabilityMeta: { "user/setting": { enabled: true } },
      env: {
        ACP_SDK_URL: pathToFileURL(
          createRequire(import.meta.url).resolve("@agentclientprotocol/sdk"),
        ).href,
        ACP_TEST_LOG: logPath,
      },
    });

    session = await client.createSession({ provider: "acp", cwd: dir });

    const log = await readAgentLog();
    const initialize = log.find((entry) => entry.method === "initialize");
    const capabilities = initialize?.clientCapabilities as
      | { _meta?: Record<string, unknown> }
      | undefined;
    expect(capabilities?._meta).toEqual({
      "user/setting": { enabled: true },
      "minimax-code/extensions": { version: 1, notifications: true },
    });
  });

  test("does not ask another ACP provider for the MiniMax extension notifications", async () => {
    const client = new GenericACPAgentClient({
      logger: createTestLogger(),
      command: [process.execPath, agentScript],
      providerId: "other-agent",
      env: {
        ACP_SDK_URL: pathToFileURL(
          createRequire(import.meta.url).resolve("@agentclientprotocol/sdk"),
        ).href,
        ACP_TEST_LOG: logPath,
      },
    });

    session = await client.createSession({ provider: "acp", cwd: dir });

    const log = await readAgentLog();
    const initialize = log.find((entry) => entry.method === "initialize");
    const capabilities = initialize?.clientCapabilities as
      | { _meta?: Record<string, unknown> }
      | undefined;
    expect(capabilities?._meta).toBeUndefined();
  });

  test("publishes the tree the provider reports", async () => {
    const client = createClient();
    session = await client.createSession({ provider: "acp", cwd: dir });
    const collector = createEventCollector(session);

    // The track names the row after the task and demotes the agent name, so
    // the agent name is the title and the task is the description. A member the
    // provider reports with a status Paseo cannot show - a queued one - has no
    // row of its own.
    expect(delegationRows(collector.events)).toEqual([
      {
        id: "child-session",
        title: "explore",
        description: "List files in working directory",
        status: "running",
        parentSubagentId: null,
      },
      {
        id: "grandchild-session",
        title: "worker",
        description: "Summarize the findings",
        status: "completed",
        parentSubagentId: "child-session",
      },
      {
        id: "instant-session",
        title: "worker",
        description: "Finish in a moment",
        status: "completed",
        parentSubagentId: null,
      },
      {
        id: "failed-session",
        title: "worker",
        description: "Fail the search",
        status: "failed",
        parentSubagentId: null,
      },
      {
        id: "stopped-session",
        title: "worker",
        description: "Stop the search",
        status: "canceled",
        parentSubagentId: null,
      },
    ]);
  });

  test("keeps a child of a parent the track cannot show", async () => {
    const client = createClient({ scenario: "hidden-parent" });
    session = await client.createSession({ provider: "acp", cwd: dir });
    const collector = createEventCollector(session);

    // The parent the provider reports as queued has no row of its own, and a
    // child that hangs under it would be hidden from the track: the user
    // cannot open a parent that is not there. The child hangs under the
    // nearest parent that does have a row, and a child of a parent the tree
    // does not hold hangs under the root.
    expect(delegationRows(collector.events)).toEqual([
      {
        id: "child-session",
        title: "explore",
        description: "List files in working directory",
        status: "running",
        parentSubagentId: null,
      },
      {
        id: "queued-child",
        title: "worker",
        description: "Report under a hidden parent",
        status: "running",
        parentSubagentId: "child-session",
      },
      {
        id: "orphan-child",
        title: "worker",
        description: "Report under a missing parent",
        status: "running",
        parentSubagentId: null,
      },
    ]);
  });

  test("waits before it shows a child the provider reports as finished before it started", async () => {
    const client = createClient({ scenario: "confirm" });
    session = await client.createSession({ provider: "acp", cwd: dir });
    const collector = createEventCollector(session);
    useControlledClock();

    await runTurn(session, collector, "go");

    // The provider published the child as finished at the moment it
    // created it. The row waits: the track must not show a child as
    // finished before it began.
    expect(rowsFor(collector.events, "late-session")).toEqual([]);

    await vi.advanceTimersByTimeAsync(DELEGATION_CONFIRMATION_MS);

    // A child that really finished is shown once the wait is over.
    expect(rowsFor(collector.events, "late-session")).toEqual([
      {
        id: "late-session",
        title: "worker",
        description: "Start late",
        status: "completed",
        parentSubagentId: null,
      },
    ]);
  });

  test("shows the child that waits while the provider keeps publishing its tree", async () => {
    const client = createClient({ scenario: "repeat" });
    session = await client.createSession({ provider: "acp", cwd: dir });
    const collector = createEventCollector(session);
    useControlledClock();

    // The provider reports the same child as finished again and again, and
    // its tree changes around it. The row must not wait for the last report:
    // it shows at the deadline of the first one.
    for (let step = 1; step <= 4; step += 1) {
      await runTurn(session, collector, "go " + step);
      await vi.advanceTimersByTimeAsync(100);
      // The row still waits: the deadline of the first report has not passed.
      expect(rowsFor(collector.events, "late-session")).toEqual([]);
    }

    await runTurn(session, collector, "go 5");
    await vi.advanceTimersByTimeAsync(100);

    // The deadline of the first report passes, so the row shows - even though
    // the provider published its tree five times since.
    expect(rowsFor(collector.events, "late-session")).toEqual([
      {
        id: "late-session",
        title: "worker",
        description: "Start late",
        status: "completed",
        parentSubagentId: null,
      },
    ]);
  });

  test("shows the live state of a child the snapshot reported as finished", async () => {
    const client = createClient({ scenario: "regress" });
    session = await client.createSession({ provider: "acp", cwd: dir });
    const collector = createEventCollector(session);

    await runTurn(session, collector, "go");

    // The tree the provider answered the read with reported the child as
    // finished, and its live state says it runs again. The row follows what
    // the provider reports, so the status goes back for a moment.
    expect(rowsFor(collector.events, "grandchild-session").map((row) => row.status)).toEqual([
      "completed",
      "running",
    ]);
  });

  test("shows the running status the provider takes the child back with", async () => {
    const client = createClient({ scenario: "confirm" });
    session = await client.createSession({ provider: "acp", cwd: dir });
    const collector = createEventCollector(session);
    useControlledClock();

    await runTurn(session, collector, "go");
    await runTurn(session, collector, "go again");

    // The provider took the child back while the row waited, so the row
    // shows the child running and never showed it as finished.
    expect(rowsFor(collector.events, "late-session")).toEqual([
      {
        id: "late-session",
        title: "worker",
        description: "Start late",
        status: "running",
        parentSubagentId: null,
      },
    ]);

    await vi.advanceTimersByTimeAsync(DELEGATION_CONFIRMATION_MS);

    // The deadline of the first report passes without the row that waited
    // showing up.
    expect(rowsFor(collector.events, "late-session")).toEqual([
      {
        id: "late-session",
        title: "worker",
        description: "Start late",
        status: "running",
        parentSubagentId: null,
      },
    ]);
  });

  test("ends with the running status when the child starts slowly", async () => {
    const client = createClient({ scenario: "confirm" });
    session = await client.createSession({ provider: "acp", cwd: dir });
    const collector = createEventCollector(session);
    useControlledClock();

    await runTurn(session, collector, "go");

    // The wait is bounded, so a child that really finished is shown as
    // finished first.
    await vi.advanceTimersByTimeAsync(DELEGATION_CONFIRMATION_MS);
    expect(rowsFor(collector.events, "late-session").map((row) => row.status)).toEqual([
      "completed",
    ]);

    // The state the provider reports afterwards is the state the row ends in.
    await runTurn(session, collector, "go again");
    expect(rowsFor(collector.events, "late-session").map((row) => row.status)).toEqual([
      "completed",
      "running",
    ]);
  });

  test("drops the waiting row when the session closes", async () => {
    const client = createClient({ scenario: "confirm" });
    session = await client.createSession({ provider: "acp", cwd: dir });
    const collector = createEventCollector(session);
    useControlledClock();

    await runTurn(session, collector, "go");
    await session.close();

    await vi.advanceTimersByTimeAsync(DELEGATION_CONFIRMATION_MS);

    // A closed session shows nothing more, so the row that waited is
    // dropped with it.
    expect(rowsFor(collector.events, "late-session")).toEqual([]);
  });

  test("shows a child of a resumed session as finished at once", async () => {
    const client = createClient();

    session = await client.resumeSession(
      { provider: "acp", sessionId: "minimax-session", metadata: { cwd: dir } },
      undefined,
      undefined,
      { purpose: "interactive" },
    );
    const collector = createEventCollector(session);

    // A tree the session reads is the state of the world: a child that
    // finished before the session resumed is shown as finished at once.
    expect(rowsFor(collector.events, "instant-session")).toEqual([
      {
        id: "instant-session",
        title: "worker",
        description: "Finish in a moment",
        status: "completed",
        parentSubagentId: null,
      },
    ]);
  });

  test("shows the tree of a resumed session", async () => {
    const client = createClient();

    session = await client.resumeSession(
      { provider: "acp", sessionId: "minimax-session", metadata: { cwd: dir } },
      undefined,
      undefined,
      { purpose: "interactive" },
    );
    const collector = createEventCollector(session);

    expect(delegationRows(collector.events)).toHaveLength(5);
  });

  test("ignores a tree the provider repeats", async () => {
    const client = createClient();
    session = await client.createSession({ provider: "acp", cwd: dir });
    const collector = createEventCollector(session);

    await runTurn(session, collector, "go");

    expect(delegationRows(collector.events)).toHaveLength(5);
  });
});
