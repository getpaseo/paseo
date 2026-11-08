import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { AgentSession, AgentStreamEvent } from "../agent-sdk-types.js";
import { buildProviderRegistry } from "../provider-registry.js";
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

  test("leaves DimCode alone", () => {
    expect(isMiniMaxCodeProvider(undefined, DIMCODE_COMMAND)).toBe(false);
    expect(isMiniMaxCodeProvider("dimcode", DIMCODE_COMMAND)).toBe(false);
    expect(isMiniMaxCodeProvider(undefined, ["dimcode", "acp"])).toBe(false);
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
      return { snapshot: tree };
    },
    async prompt() {
      if (scenario === "regress") {
        await connection.extNotification("mcode/session/delegation_update", {
          sessionId: "minimax-session",
          snapshot: regressedTree,
        });
        return { stopReason: "end_turn" };
      }
      if (scenario === "confirm-repeat") {
        // The provider reports the same child as finished again and again,
        // while the tree it publishes changes around it.
        for (let index = 0; index < 30; index += 1) {
          await connection.extNotification("mcode/session/delegation_update", {
            sessionId: "minimax-session",
            snapshot: {
              ...withLate,
              members: [
                ...withLate.members,
                member("churn-" + index, "root-session", "worker", "Churn " + index, "running", 9000, 9000),
              ],
            },
          });
          log({ method: "delegation_update", index });
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return { stopReason: "end_turn" };
      }
      if (scenario === "confirm") {
        await connection.extNotification("mcode/session/delegation_update", {
          sessionId: "minimax-session",
          snapshot: withLate,
        });
        await new Promise((resolve) => setTimeout(resolve, 100));
        await connection.extNotification("mcode/session/delegation_update", {
          sessionId: "minimax-session",
          snapshot: withLateRunning,
        });
        return { stopReason: "end_turn" };
      }
      if (scenario === "confirm-only") {
        await connection.extNotification("mcode/session/delegation_update", {
          sessionId: "minimax-session",
          snapshot: withLate,
        });
        return { stopReason: "end_turn" };
      }
      if (scenario === "confirm-slow") {
        await connection.extNotification("mcode/session/delegation_update", {
          sessionId: "minimax-session",
          snapshot: withLate,
        });
        await new Promise((resolve) => setTimeout(resolve, 900));
        await connection.extNotification("mcode/session/delegation_update", {
          sessionId: "minimax-session",
          snapshot: withLateRunning,
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

  function rowsFor(events: AgentStreamEvent[], id: string): Array<Record<string, unknown>> {
    return delegationRows(events).filter((row) => row.id === id);
  }
  test("publishes the tree the provider reports", async () => {
    const client = createClient();
    session = await client.createSession({ provider: "acp", cwd: dir });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    // The track names the row after the task and demotes the agent name, so
    // the agent name is the title and the task is the description. A member the
    // provider reports with a status Paseo cannot show - a queued one - has no
    // row of its own.
    expect(delegationRows(events)).toEqual([
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

  test("waits before it shows a child the provider reports as finished before it started", async () => {
    const client = createClient({ scenario: "confirm-only" });
    session = await client.createSession({ provider: "acp", cwd: dir });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    await session.startTurn("go");

    // The provider published the child as finished at the moment it
    // created it. The row waits: the track must not show a child as
    // finished before it began.
    expect(rowsFor(events, "late-session")).toEqual([]);

    await new Promise((resolve) => setTimeout(resolve, 700));

    // A child that really finished is shown once the wait is over.
    expect(rowsFor(events, "late-session")).toEqual([
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
    const client = createClient({ scenario: "confirm-repeat" });
    session = await client.createSession({ provider: "acp", cwd: dir });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    await session.startTurn("go");

    // The provider reports the same child as finished again and again, and
    // its tree changes around it. The row must not wait for the last report:
    // it shows at the deadline of the first one.
    const giveUpAt = Date.now() + 3000;
    while (Date.now() < giveUpAt && rowsFor(events, "late-session").length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const late = rowsFor(events, "late-session");
    expect(late.length).toBeGreaterThan(0);
    expect(late[0]).toEqual({
      id: "late-session",
      title: "worker",
      description: "Start late",
      status: "completed",
      parentSubagentId: null,
    });

    // The provider was still publishing its tree when the row showed.
    const log = await readAgentLog();
    const updates = log.filter((entry) => entry.method === "delegation_update").length;
    expect(updates).toBeLessThan(30);
  });

  test("shows the live state of a child the snapshot reported as finished", async () => {
    const client = createClient({ scenario: "regress" });
    session = await client.createSession({ provider: "acp", cwd: dir });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    await session.startTurn("go");
    await new Promise((resolve) => setTimeout(resolve, 100));

    // The tree the provider answered the read with reported the child as
    // finished, and its live state says it runs again. The row follows what
    // the provider reports, so the status goes back for a moment.
    expect(rowsFor(events, "grandchild-session").map((row) => row.status)).toEqual([
      "completed",
      "running",
    ]);
  });

  test("shows the running status the provider takes the child back with", async () => {
    const client = createClient({ scenario: "confirm" });
    session = await client.createSession({ provider: "acp", cwd: dir });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    await session.startTurn("go");
    await new Promise((resolve) => setTimeout(resolve, 300));

    // The provider took the child back while the row waited, so the row
    // shows the child running and never showed it as finished.
    expect(rowsFor(events, "late-session")).toEqual([
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
    const client = createClient({ scenario: "confirm-slow" });
    session = await client.createSession({ provider: "acp", cwd: dir });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    await session.startTurn("go");
    await new Promise((resolve) => setTimeout(resolve, 1200));

    // The wait is bounded, so a child that starts after it is shown as
    // finished first and as running afterwards. The state it ends in is the
    // state the provider reports.
    expect(rowsFor(events, "late-session").map((row) => row.status)).toEqual([
      "completed",
      "running",
    ]);
  });

  test("drops the waiting row when the session closes", async () => {
    const client = createClient({ scenario: "confirm-only" });
    session = await client.createSession({ provider: "acp", cwd: dir });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    await session.startTurn("go");
    await session.close();
    await new Promise((resolve) => setTimeout(resolve, 700));

    // A closed session shows nothing more, so the row that waited is
    // dropped with it.
    expect(rowsFor(events, "late-session")).toEqual([]);
  });

  test("shows a child of a resumed session as finished at once", async () => {
    const client = createClient();

    session = await client.resumeSession(
      { provider: "acp", sessionId: "minimax-session", metadata: { cwd: dir } },
      undefined,
      undefined,
      { purpose: "interactive" },
    );
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    // A tree the session reads is the state of the world: a child that
    // finished before the session resumed is shown as finished at once.
    expect(rowsFor(events, "instant-session")).toEqual([
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
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    expect(delegationRows(events)).toHaveLength(5);
  });

  test("ignores a tree the provider repeats", async () => {
    const client = createClient();
    session = await client.createSession({ provider: "acp", cwd: dir });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    await session.startTurn("go");
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(delegationRows(events)).toHaveLength(5);
  });
});
