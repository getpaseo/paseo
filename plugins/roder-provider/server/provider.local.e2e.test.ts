import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PROVIDER_CAPABILITIES,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
  type ProviderRegistration,
} from "@getpaseo/plugin/server/provider";
import contribute from "../index.server.js";

// Use Roder 0.3.25 or newer; mock inference keeps these checks offline.
const roderBinary = process.env.RODER_TEST_BINARY;

describe.skipIf(!roderBinary)("Roder ACP plugin with the real CLI", () => {
  let directory: string;
  let connection: ProviderConnection;
  let events: ProviderEvent[];
  let provider: ProviderRegistration;

  async function connect(): Promise<void> {
    connection = await provider.connect({
      versions: [1],
      capabilities: PROVIDER_CAPABILITIES,
      launch: {
        command: roderBinary ?? "roder",
        args: ["acp", "--config-dir", path.join(directory, "config")],
        env: {
          ...process.env,
          RODER_PROVIDER: "mock",
          RODER_MODEL: "mock",
          RODER_DATA_DIR: path.join(directory, "data"),
        },
      },
    });
    events = [];
    connection.onEvent((event) => events.push(event));
  }

  beforeEach(async () => {
    directory = await realpath(await mkdtemp(path.join(tmpdir(), "paseo-roder-")));
    const registrations: ProviderRegistration[] = [];
    contribute({ registerProvider: (registration) => registrations.push(registration) });
    expect(registrations).toHaveLength(1);
    provider = registrations[0];
    expect(provider).toMatchObject({
      id: "roder",
      label: "Roder",
      requiresConfiguration: true,
      command: ["roder", "acp"],
    });
    await connect();
  });

  afterEach(async () => {
    await connection?.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function waitForEvent(expected: Partial<ProviderEvent>): Promise<void> {
    await expect
      .poll(() => events, { timeout: 15_000 })
      .toContainEqual(expect.objectContaining(expected));
  }

  function openInput(): Extract<ProviderInput, { type: "session.open" }> {
    return {
      type: "session.open",
      requestId: "open",
      sessionId: "session",
      config: { cwd: directory, env: {}, mcpServers: {}, settings: {}, persist: true },
      history: "skip",
    };
  }

  async function promptHello(): Promise<void> {
    await connection.send({
      type: "session.prompt",
      sessionId: "session",
      prompt: {
        clientMessageId: "message",
        delivery: "auto",
        input: { type: "message", content: [{ type: "text", text: "Say hello" }] },
      },
    });
    await waitForEvent({ type: "session.turn", sessionId: "session", state: "completed" });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "timeline.item",
        sessionId: "session",
        item: expect.objectContaining({ type: "assistant_message", text: "hello from roder" }),
      }),
    );
  }

  it("streams text and exposes model, mode, image and persistence capabilities", async () => {
    expect(connection.capabilities).toEqual(
      expect.arrayContaining(["session.persistence", "session.list", "prompt.image"]),
    );
    await connection.send({ type: "catalog", requestId: "catalog" });
    await waitForEvent({ type: "catalog", catalog: { models: [], modes: [] } });
    await connection.send(openInput());
    await waitForEvent({ type: "session.ready", sessionId: "session" });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session.config",
        config: expect.objectContaining({
          model: "mock/mock",
          modes: expect.arrayContaining([expect.objectContaining({ id: "plan" })]),
        }),
      }),
    );
    await connection.send({
      type: "session.configure",
      requestId: "configure",
      sessionId: "session",
      changes: { model: "mock/mock", mode: "plan" },
    });
    await waitForEvent({ type: "request.completed", requestId: "configure" });
    await promptHello();
    await connection.send({ type: "session.close", requestId: "close", sessionId: "session" });
    await waitForEvent({ type: "session.closed", sessionId: "session" });
    expect(events.filter((event) => event.type === "request.failed")).toEqual([]);
  });

  it("lists and restores a conversation and its mode through a fresh provider process", async () => {
    const input = openInput();
    input.config.systemPrompt = "Keep answers brief.";
    input.config.mode = "plan";
    await connection.send(input);
    await waitForEvent({ type: "session.ready", sessionId: "session" });
    await promptHello();
    const opened = events.find((event) => event.type === "session.opened");
    if (opened?.type !== "session.opened" || !opened.persistence)
      throw new Error("Missing persistent native session ID");
    await connection.close();
    await connect();
    await connection.send({ type: "sessions", requestId: "list", cwd: directory });
    await waitForEvent({ type: "sessions", requestId: "list" });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "sessions",
        sessions: expect.arrayContaining([
          expect.objectContaining({ persistence: opened.persistence, cwd: directory }),
        ]),
      }),
    );
    await connection.send({
      ...input,
      requestId: "restore",
      config: { ...input.config, mode: undefined },
      persistence: opened.persistence,
      history: "replay",
    });
    await waitForEvent({ type: "session.ready", requestId: "restore" });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session.config",
        config: expect.objectContaining({ mode: "plan", model: "mock/mock" }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "timeline.item",
        item: expect.objectContaining({ type: "assistant_message", text: "hello from roder" }),
      }),
    );
    expect(events.filter((event) => event.type === "request.failed")).toEqual([]);
  });

  it("starts injected stdio MCP in the workspace with its environment and closes the child", async () => {
    const script = path.join(directory, "fixture.mjs");
    const marker = path.join(directory, "mcp-started.json");
    await writeFile(
      script,
      `
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
writeFileSync("mcp-started.json", JSON.stringify({ pid: process.pid, cwd: process.cwd(), value: process.env.ACP_SENTINEL }));
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  const result = request.method === "initialize"
    ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
    : { tools: [{ name: "echo", description: "echo", inputSchema: { type: "object", properties: {} } }] };
  console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
}
`,
    );
    const input = openInput();
    input.config.mcpServers = {
      fixture: {
        type: "stdio",
        command: process.execPath,
        args: [script],
        env: { ACP_SENTINEL: "injected" },
      },
    };
    await connection.send(input);
    await waitForEvent({ type: "session.ready", sessionId: "session" });
    const started = JSON.parse(await readFile(marker, "utf8")) as {
      pid: number;
      cwd: string;
      value: string;
    };
    expect(started).toMatchObject({ cwd: directory, value: "injected" });
    await connection.send({ type: "session.close", requestId: "close", sessionId: "session" });
    await waitForEvent({ type: "session.closed", sessionId: "session" });
    expect(() => process.kill(started.pid, 0)).toThrow();
  });

  it("reports an MCP startup failure instead of dropping requested tools", async () => {
    const input = openInput();
    input.config.mcpServers = {
      broken: { type: "stdio", command: "/nonexistent/roder-mcp-fixture", args: [] },
    };
    await connection.send(input);
    await waitForEvent({ type: "request.failed", requestId: "open" });
    expect(events.filter((event) => event.type === "session.ready")).toEqual([]);
  });
});
