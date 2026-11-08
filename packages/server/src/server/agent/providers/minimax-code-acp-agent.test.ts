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

  function createClient() {
    return new MiniMaxCodeACPAgentClient({
      logger: createTestLogger(),
      command: [process.execPath, agentScript],
      providerId: "minimax-code",
      env: {
        ACP_SDK_URL: pathToFileURL(
          createRequire(import.meta.url).resolve("@agentclientprotocol/sdk"),
        ).href,
        ACP_TEST_LOG: logPath,
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
