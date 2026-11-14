import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test, vi } from "vitest";
import type { ProviderEvent, ProviderInput } from "@getpaseo/plugin/server/provider";
import { createZCodeProvider } from "./provider.js";

const fakeServer = fileURLToPath(new URL("../test/fake-zcode-app-server.mjs", import.meta.url));

function launchFor(mode: string) {
  return {
    command: process.execPath,
    args: [fakeServer],
    env: { ...process.env, FAKE_ZCODE_MODE: mode },
  };
}

async function connect(mode: string, capabilities: readonly string[]) {
  const provider = createZCodeProvider();
  const connection = await provider.connect({
    launch: launchFor(mode),
    versions: [1],
    capabilities,
  });
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));
  return { connection, events };
}

const sessionConfig = {
  cwd: "/tmp",
  env: {},
  mcpServers: {},
  settings: {},
  persist: false,
};

/** Waits until the given number of sessions reported themselves ready. */
async function waitForReadySessions(events: ProviderEvent[], count: number) {
  await vi.waitFor(() => {
    const ready = events.filter((event) => event.type === "session.ready");
    expect(ready).toHaveLength(count);
  });
}

/** Waits for the completion of the request with the given id. */
async function waitForCompleted(events: ProviderEvent[], requestId: string) {
  await vi.waitFor(() => {
    expect(
      events.some((event) => event.type === "request.completed" && event.requestId === requestId),
    ).toBe(true);
  });
}

/** Waits for an event of the given type to arrive. */
async function waitForEvent(events: ProviderEvent[], type: ProviderEvent["type"]) {
  await vi.waitFor(() => {
    expect(events.some((event) => event.type === type)).toBe(true);
  });
}

/** Whether an assistant message reached the timeline. */
function hasAssistantMessage(events: ProviderEvent[]): boolean {
  return events.some(
    (event) => event.type === "timeline.item" && event.item.type === "assistant_message",
  );
}

/** Whether a turn reached its completed state. */
function hasCompletedTurn(events: ProviderEvent[]): boolean {
  return events.some((event) => event.type === "session.turn" && event.state === "completed");
}

async function openSession(
  connection: Awaited<ReturnType<typeof connect>>["connection"],
  events: ProviderEvent[],
) {
  await connection.send({
    type: "session.open",
    requestId: "r1",
    sessionId: "p1",
    config: sessionConfig,
    history: "skip",
  } as ProviderInput);
  await waitForEvent(events, "session.ready");
}

async function sendHello(
  connection: Awaited<ReturnType<typeof connect>>["connection"],
  sessionId = "p1",
) {
  await connection.send({
    type: "session.prompt",
    sessionId,
    prompt: {
      clientMessageId: "m1",
      delivery: "auto",
      input: { type: "message", content: [{ type: "text", text: "hello" }] },
    },
  } as ProviderInput);
}

describe("ZCode provider", () => {
  test("negotiates capabilities and does not advertise rewind", async () => {
    const provider = createZCodeProvider();
    const connection = await provider.connect({
      launch: launchFor("ok"),
      versions: [1],
      capabilities: ["prompt.message", "session.persistence"],
    });
    expect(connection.capabilities).toContain("prompt.message");
    expect(connection.capabilities).not.toContain("session.revert.conversation");
    await connection.close();
  });

  test("refuses a protocol version it does not implement", async () => {
    const provider = createZCodeProvider();
    await expect(
      provider.connect({
        launch: launchFor("ok"),
        versions: [2],
        capabilities: ["prompt.message"],
      }),
    ).rejects.toThrow(/version 1/);
  });

  test("opens a session and reports it ready", async () => {
    const { connection, events } = await connect("ok", ["prompt.message"]);
    await openSession(connection, events);
    await connection.close();
  });

  test("reads the catalog from a session snapshot", async () => {
    const { connection, events } = await connect("ok", ["prompt.message"]);
    await connection.send({ type: "catalog", requestId: "r1", cwd: "/tmp" } as ProviderInput);

    await waitForEvent(events, "catalog");
    const catalog = events.find((event) => event.type === "catalog");
    expect(catalog).toMatchObject({
      catalog: {
        models: [{ id: "zai/glm-5" }, { id: "zai/glm-4" }],
        defaultModel: "zai/glm-5",
        defaultMode: "plan",
        defaultThinkingOption: "high",
      },
    });
    await connection.close();
  });

  test("streams the reply and the usage of a finished turn", async () => {
    const { connection, events } = await connect("ok", ["prompt.message", "session.persistence"]);
    await openSession(connection, events);
    await sendHello(connection);

    await vi.waitFor(() => {
      expect(hasAssistantMessage(events)).toBe(true);
    });
    await vi.waitFor(() => {
      expect(hasCompletedTurn(events)).toBe(true);
    });
    expect(
      events.some((event) => event.type === "session.usage" && event.usage.inputTokens === 12),
    ).toBe(true);
    await connection.close();
  });

  test("answers the permission ZCode asks for with a reverse request", async () => {
    const { connection, events } = await connect("permission", ["prompt.message", "permission"]);
    await openSession(connection, events);

    // The fake app-server sends the permission as a reverse request and waits
    // for the answer on that request.
    await sendHello(connection);

    await waitForEvent(events, "session.permission");
    const permission = events.find((event) => event.type === "session.permission") as
      | Extract<ProviderEvent, { type: "session.permission" }>
      | undefined;
    expect(permission?.request.actions.map((action) => action.id)).toEqual(["allow", "deny"]);

    await connection.send({
      type: "session.permission",
      sessionId: "p1",
      permissionId: permission!.request.id,
      response: { behavior: "allow", selectedActionId: "allow" },
    } as ProviderInput);

    await waitForEvent(events, "session.permission_resolved");
    await connection.close();
  });

  test("reports the failure when the runtime dies", async () => {
    const { connection, events } = await connect("exit", ["prompt.message"]);
    await connection.send({
      type: "session.open",
      requestId: "r1",
      sessionId: "p1",
      config: sessionConfig,
      history: "skip",
    } as ProviderInput);

    await waitForEvent(events, "session.runtime_failed");
    await connection.close();
  });

  test("completes the requests that change a running session", async () => {
    // The host waits for `request.completed` before it considers a
    // configure, an interrupt, an archive or an unarchive done. Without it the
    // caller waits forever.
    const { connection, events } = await connect("ok", [
      "prompt.message",
      "session.configure",
      "session.persistence",
    ]);
    await openSession(connection, events);

    await connection.send({
      type: "session.configure",
      requestId: "configure-1",
      sessionId: "p1",
      changes: { model: "zai/glm-4" },
    } as ProviderInput);
    await waitForCompleted(events, "configure-1");

    await connection.send({
      type: "session.interrupt",
      requestId: "interrupt-1",
      sessionId: "p1",
    } as ProviderInput);
    await waitForCompleted(events, "interrupt-1");

    await connection.close();
  });

  test("gives the bundled runtime the provider config it needs", async () => {
    // The daemon owns the environment and replaces the one the discovery
    // found. The bundled runtime needs the path of the built-in provider
    // config, or it exits before it answers anything.
    const root = await mkdtemp(join(tmpdir(), "zcode-bundle-"));
    const bundleDir = join(root, "resources", "glm");
    const configDir = join(root, "resources", "config", "provider");
    await mkdir(bundleDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    const bundle = join(bundleDir, "zcode.cjs");
    // The desktop bundle is a CommonJS file that runs the app-server.
    await writeFile(bundle, `import(${JSON.stringify(fakeServer)});\n`);
    const configPath = join(configDir, "zcode-builtin.json");
    await writeFile(configPath, "{}\n");
    const envFile = join(root, "child-env.json");

    const provider = createZCodeProvider();
    const connection = await provider.connect({
      launch: {
        command: process.execPath,
        args: [bundle, "app-server", "--stdio"],
        // The daemon's environment: it does not carry the config path.
        env: {
          PATH: process.env.PATH ?? "",
          FAKE_ZCODE_MODE: "report-env",
          FAKE_ZCODE_ENV_FILE: envFile,
        },
      },
      versions: [1],
      capabilities: ["prompt.message"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));

    await connection.send({ type: "catalog", requestId: "r1", cwd: "/tmp" } as ProviderInput);
    await waitForEvent(events, "catalog");

    const childEnv = JSON.parse(await readFile(envFile, "utf8")) as Record<string, string>;
    expect(childEnv["ELECTRON_RUN_AS_NODE"]).toBe("1");
    expect(childEnv["ZCODE_BUILTIN_PROVIDER_CONFIG_FILE"]).toBe(configPath);
    await connection.close();
  });

  test("keeps another session's events out of a session's timeline", async () => {
    // The transport is shared, so every session sees every event. A session
    // that forwards them all labels another agent's messages with its own id.
    const { connection, events } = await connect("ok", ["prompt.message"]);
    await openSession(connection, events);
    await connection.send({
      type: "session.open",
      requestId: "r2",
      sessionId: "p2",
      config: sessionConfig,
      history: "skip",
    } as ProviderInput);
    await waitForReadySessions(events, 2);

    await sendHello(connection, "p2");

    await vi.waitFor(() => {
      expect(hasAssistantMessage(events)).toBe(true);
    });
    // The reply belongs to the session that asked for it.
    const messages = events.filter(
      (event) => event.type === "timeline.item" && event.item.type === "assistant_message",
    );
    expect(messages.every((event) => event.sessionId === "p2")).toBe(true);

    await connection.close();
  });
});
