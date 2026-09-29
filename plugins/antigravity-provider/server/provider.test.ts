import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  PROVIDER_CAPABILITIES,
  ProviderEventSchema,
  type ProviderConnection,
  type ProviderContent,
  type ProviderEvent,
  type ProviderInput,
  type ProviderLaunch,
  type ProviderPersistence,
} from "@getpaseo/plugin/server/provider";
import { signalPlan } from "./internal/signals.js";
import { createAntigravityProvider } from "./provider.js";

const temporary: string[] = [];
const connections: ProviderConnection[] = [];
const fake = fileURLToPath(new URL("../test/agy.mjs", import.meta.url));
const provider = createAntigravityProvider();
afterEach(async () => {
  await Promise.all(connections.splice(0).map((connection) => connection.close()));
  await Promise.all(
    temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function harness(env: Record<string, string> = {}) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "antigravity-test-"));
  temporary.push(cwd);
  const log = path.join(cwd, "argv.ndjson");
  const launch: ProviderLaunch = {
    command: process.execPath,
    args: [fake, "--launch-prefix"],
    env: { AGY_TEST_LOG: log, ...env },
  };
  const connection = await provider.connect({
    versions: [1],
    capabilities: PROVIDER_CAPABILITIES,
    launch,
  });
  connections.push(connection);
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => {
    ProviderEventSchema.parse(event);
    events.push(event);
  });
  async function wait(predicate: (event: ProviderEvent) => boolean) {
    await expect.poll(() => events.some(predicate), { timeout: 5000, interval: 10 }).toBe(true);
    const event = events.find(predicate);
    if (!event) throw new Error("Expected event missing");
    return event;
  }
  async function request(input: ProviderInput) {
    await connection.send(input);
    if ("requestId" in input)
      await wait(
        (event) =>
          "requestId" in event &&
          event.requestId === input.requestId &&
          (event.type === "request.completed" ||
            event.type === "request.failed" ||
            event.type === "session.ready" ||
            event.type === "catalog"),
      );
  }
  async function open(restored?: ProviderPersistence, sessionId = "s") {
    await request({
      type: "session.open",
      requestId: `open-${events.length}`,
      sessionId,
      persistence: restored,
      history: "replay",
      config: {
        cwd,
        env: { AGY_SESSION_VALUE: "session-overlay" },
        settings: {},
        mcpServers: {},
        persist: true,
        systemPrompt: "SYSTEM PREFIX",
      },
    });
  }
  async function message(content: ProviderContent[], sessionId = "s") {
    const clientMessageId = `prompt-${events.length}`;
    await connection.send({
      type: "session.prompt",
      sessionId,
      prompt: {
        clientMessageId,
        delivery: "auto",
        input: { type: "message", content },
      },
    });
    await wait(
      (event) =>
        event.type === "session.prompt_result" && event.clientMessageId === clientMessageId,
    );
    return clientMessageId;
  }
  function prompt(text: string) {
    return message([{ type: "text", text }]);
  }
  async function completed(clientMessageId: string) {
    const result = events.find(
      (event) =>
        event.type === "session.prompt_result" && event.clientMessageId === clientMessageId,
    );
    if (!result || result.type !== "session.prompt_result" || result.result.type !== "turn")
      throw new Error("Prompt was not admitted");
    const turnId = result.result.turnId;
    return wait(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
    );
  }
  async function records() {
    return (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  }
  function persistence() {
    const opened = events.find((event) => event.type === "session.opened");
    if (!opened || opened.type !== "session.opened" || !opened.persistence)
      throw new Error("Missing persistence");
    return opened.persistence;
  }
  return {
    connection,
    events,
    launch,
    cwd,
    wait,
    request,
    open,
    prompt,
    message,
    completed,
    records,
    persistence,
  };
}

it("streams complete text snapshots, prefixes the system prompt only once and preserves launch argv/env", async () => {
  const h = await harness();
  expect(h.connection.capabilities).toEqual([
    "prompt.message",
    "prompt.image",
    "session.configure",
    "session.persistence",
  ]);
  await h.open();
  await h.completed(await h.prompt("HELLO"));
  await h.completed(await h.prompt("HELLO AGAIN"));
  const text = h.events.filter(
    (event) => event.type === "timeline.item" && event.item.type === "assistant_message",
  );
  expect(
    text.map((event) =>
      event.type === "timeline.item" && event.item.type === "assistant_message"
        ? event.item.text
        : "",
    ),
  ).toEqual(["PHASE0_HELLO", "PHASE0_HELLO\n", "PHASE0_HELLO", "PHASE0_HELLO\n"]);
  const records = await h.records();
  expect(records.find((entry) => entry.args.includes("--input-format")).args).toEqual([
    "--launch-prefix",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--add-dir",
    h.cwd,
    "--disable-slash-commands",
  ]);
  expect(records.find((entry) => entry.args.includes("--input-format")).env).toBe(
    "session-overlay",
  );
  expect(
    records.filter((entry) => entry.input).map((entry) => entry.input.message.content),
  ).toEqual(["SYSTEM PREFIX\n\nHELLO", "HELLO AGAIN"]);
});

it("maps tools and emits one denial notice for a SUCCESS result", async () => {
  const h = await harness();
  await h.open();
  // This capture contains three distinct native results, one for each submitted prompt.
  await h.completed(await h.prompt("TOOLS"));
  await h.completed(await h.prompt("TOOLS"));
  const result = await h.completed(await h.prompt("TOOLS"));
  expect(result).toMatchObject({ type: "session.turn", state: "completed" });
  const tools = h.events.filter(
    (event) => event.type === "timeline.item" && event.item.type === "tool_call",
  );
  expect(tools).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        item: expect.objectContaining({
          name: "view_file",
          status: "completed",
          detail: expect.objectContaining({ type: "read" }),
        }),
      }),
      expect.objectContaining({
        item: expect.objectContaining({
          name: "write_to_file",
          status: "completed",
          detail: expect.objectContaining({ type: "write" }),
        }),
      }),
      expect.objectContaining({
        item: expect.objectContaining({
          name: "run_command",
          status: "failed",
          detail: expect.objectContaining({ type: "shell", command: "printf PHASE0_SHELL" }),
        }),
      }),
    ]),
  );
  const notices = h.events.filter((event) => event.type === "session.notice");
  expect(notices).toHaveLength(1);
  expect(notices[0]).toMatchObject({
    notice: {
      title: "Antigravity denied: RunCommand",
      description: expect.stringContaining("Choose Full access"),
    },
  });
});

it("accounts DONE generation usage once without adding cumulative results, including resume", async () => {
  const h = await harness();
  await h.open();
  await h.completed(await h.prompt("MULTI"));
  await h.completed(await h.prompt("MULTI"));
  const usages = h.events.filter((event) => event.type === "session.usage");
  expect(
    usages.map((event) => (event.type === "session.usage" ? event.usage.inputTokens : null)),
  ).toEqual([11263, 11604]);
  const persistence = h.persistence();
  await h.request({ type: "session.close", sessionId: "s", requestId: "close" });
  await h.open(persistence);
  await h.completed(await h.prompt("RESUME"));
  expect(h.events.filter((event) => event.type === "session.usage")).toHaveLength(3);
  expect(h.events.findLast((event) => event.type === "session.usage")).toMatchObject({
    usage: { inputTokens: 11815 },
  });
});

it("maps subagent steps to a tool carrying the child conversation ID", async () => {
  const h = await harness();
  await h.open();
  await h.completed(await h.prompt("SUBAGENT"));
  expect(h.events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "timeline.item",
        item: expect.objectContaining({
          name: "invoke_subagent",
          status: "completed",
          detail: expect.objectContaining({
            type: "sub_agent",
            childSessionId: "b6f02329-7415-49a7-a9a9-1cd09e898d26",
          }),
        }),
      }),
    ]),
  );
});

it.each(["HANG", "TOOL_HANG"])(
  "interrupts %s, settles canceled, and respawns the same conversation",
  async (text) => {
    const h = await harness();
    await h.open();
    const message = await h.prompt(text);
    await h.wait(
      (event) =>
        event.type === "timeline.item" &&
        (event.item.type === "assistant_message" || event.item.type === "tool_call"),
    );
    await h.request({ type: "session.interrupt", requestId: "interrupt", sessionId: "s" });
    expect(await h.completed(message)).toMatchObject({ state: "canceled" });
    await h.completed(await h.prompt("HELLO"));
    const records = await h.records();
    const launches = records.filter((entry) => entry.args && entry.args.includes("--input-format"));
    expect(launches).toHaveLength(2);
    expect(launches[1].args.slice(-2)).toEqual([
      "--conversation",
      "e5cf1e2d-c715-4328-8e67-4a85c8dc3cda",
    ]);
    // Windows taskkill terminates the tree without invoking the CLI's signal handlers.
    expect(records.filter((entry) => entry.signal)).toEqual(
      process.platform === "win32" ? [] : [{ signal: "SIGINT" }],
    );
    const canceled = h.events.filter(
      (event) => event.type === "session.turn" && event.state === "canceled",
    );
    expect(canceled).toHaveLength(1);
  },
);

it("stops an unresponsive driver and still respawns the conversation", async () => {
  const h = await harness({ AGY_TEST_IGNORE_SIGNALS: "yes" });
  await h.open();
  const message = await h.prompt("HANG");
  await h.wait(
    (event) => event.type === "timeline.item" && event.item.type === "assistant_message",
  );
  await h.request({ type: "session.interrupt", requestId: "interrupt-timeout", sessionId: "s" });
  expect(await h.completed(message)).toMatchObject({ state: "canceled" });
  expect((await h.records()).filter((entry) => entry.signal)).toEqual(
    process.platform === "win32" ? [] : [{ signal: "SIGINT" }, { signal: "SIGTERM" }],
  );
  await h.completed(await h.prompt("HELLO"));
});

it.each(["accept-edits", "plan"])(
  "launches native %s mode without claiming read-only access",
  async (mode) => {
    const h = await harness();
    await h.open();
    await h.request({
      type: "session.configure",
      requestId: "mode",
      sessionId: "s",
      changes: { mode },
    });
    await h.completed(await h.prompt("HELLO"));
    const launches = (await h.records()).filter(
      (entry) => entry.args && entry.args.includes("--input-format"),
    );
    expect(launches[1].args).toContain("--mode");
    expect(launches[1].args[launches[1].args.indexOf("--mode") + 1]).toBe(mode);
  },
);

it("defers model and mode changes until the next prompt, then respawns with validated flags", async () => {
  const h = await harness();
  await h.open();
  await h.request({
    type: "session.configure",
    requestId: "change",
    sessionId: "s",
    changes: { model: "gemini-3.8-flash-low", mode: "full-access" },
  });
  expect(
    (await h.records()).filter((entry) => entry.args && entry.args.includes("--input-format")),
  ).toHaveLength(1);
  await h.completed(await h.prompt("HELLO"));
  const launches = (await h.records()).filter(
    (entry) => entry.args && entry.args.includes("--input-format"),
  );
  expect(launches).toHaveLength(2);
  expect(launches[1].args.slice(-5)).toEqual([
    "--model",
    "gemini-3.8-flash-low",
    "--dangerously-skip-permissions",
    "--conversation",
    "e5cf1e2d-c715-4328-8e67-4a85c8dc3cda",
  ]);
  await h.request({
    type: "session.configure",
    requestId: "invalid",
    sessionId: "s",
    changes: { model: "unknown" },
  });
  expect(h.events).toContainEqual(
    expect.objectContaining({
      type: "request.failed",
      requestId: "invalid",
      error: expect.objectContaining({ code: "INVALID_MODEL" }),
    }),
  );
});

it("resumes after connection close without replay or another system prefix", async () => {
  const first = await harness();
  await first.open();
  await first.completed(await first.prompt("HELLO"));
  const persistence = first.persistence();
  await first.connection.close();
  const second = await harness();
  await second.open(persistence);
  expect(second.events.filter((event) => event.type === "timeline.item")).toEqual([]);
  await second.completed(await second.prompt("RESUME"));
  expect(
    (await second.records())
      .filter((entry) => entry.input)
      .map((entry) => entry.input.message.content),
  ).toEqual(["RESUME"]);
});

it.each(["auth", "exit", "stderr"])(
  "reports startup %s without waiting for init forever",
  async (startup) => {
    const h = await harness({ AGY_TEST_STARTUP: startup });
    await h.open();
    expect(h.events.filter((event) => event.type === "session.ready")).toEqual([]);
    const failure = h.events.find((event) => event.type === "request.failed");
    expect(failure).toMatchObject({
      type: "request.failed",
      error: {
        message: expect.stringMatching(startup === "exit" ? /exited/ : /Run `agy` and sign in/),
      },
    });
  },
);

it("rejects mid-turn steering and reports a busy message without queueing a second native turn", async () => {
  const h = await harness();
  await h.open();
  await h.prompt("HANG");
  const second = await h.prompt("SECOND");
  expect(
    h.events.find(
      (event) => event.type === "session.prompt_result" && event.clientMessageId === second,
    ),
  ).toMatchObject({
    type: "session.prompt_result",
    result: { type: "failed", error: { code: "TURN_ACTIVE" } },
  });
  await expect(
    h.connection.send({
      type: "session.prompt",
      sessionId: "s",
      prompt: {
        clientMessageId: "steer",
        delivery: "steer",
        input: { type: "message", content: [{ type: "text", text: "x" }] },
      },
    }),
  ).rejects.toThrow(/prompt.steer/);
});

describe("discovery", () => {
  it("reuses one discovered catalog for two opens and configure, and refreshes explicit catalog requests", async () => {
    const h = await harness();
    await h.open();
    await h.open(undefined, "second");
    await h.request({
      type: "session.configure",
      requestId: "configure-cached",
      sessionId: "second",
      changes: { model: "gemini-3.8-flash-low" },
    });
    expect(
      (await h.records()).filter((entry) => entry.args && entry.args.includes("models")),
    ).toHaveLength(1);
    await h.request({ type: "catalog", requestId: "refresh" });
    expect(
      (await h.records()).filter((entry) => entry.args && entry.args.includes("models")),
    ).toHaveLength(2);
  });
  it.each(["1.1.15", "1.2.12", "1.2.13"])("accepts driver-capable version %s", async (version) => {
    const h = await harness({ AGY_TEST_VERSION: version });
    expect(await provider.status?.({ launch: h.launch })).toEqual({ available: true });
  });

  it("parses tab-separated catalog and exposes native permission choices without thinking options", async () => {
    const h = await harness();
    await h.request({ type: "catalog", requestId: "catalog" });
    const event = h.events[0];
    expect(event).toMatchObject({
      type: "catalog",
      catalog: {
        models: expect.arrayContaining([
          { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)" },
        ]),
        thinkingOptions: [],
        defaultMode: "default",
      },
    });
    if (event.type !== "catalog") throw new Error("Missing catalog");
    expect(event.catalog.models).toHaveLength(11);
    expect(event.catalog.modes.map((mode) => mode.label)).toEqual([
      "Default",
      "Accept edits",
      "Plan",
      "Full access",
    ]);
    expect(event.catalog.modes.map((mode) => mode.id)).toEqual([
      "default",
      "accept-edits",
      "plan",
      "full-access",
    ]);
  });
  it("reports missing, old, unauthenticated and available launches", async () => {
    expect(await provider.status?.({})).toMatchObject({
      available: false,
      diagnostic: expect.stringContaining("agy not found"),
    });
    const missing = await harness();
    expect(
      await provider.status?.({
        launch: { ...missing.launch, command: path.join(missing.cwd, "missing-agy") },
      }),
    ).toMatchObject({ available: false, diagnostic: expect.stringContaining("ENOENT") });
    const old = await harness({ AGY_TEST_VERSION: "1.1.14" });
    expect(await provider.status?.({ launch: old.launch })).toMatchObject({
      available: false,
      diagnostic: expect.stringContaining("1.1.15"),
    });
    const unauthenticated = await harness({ AGY_TEST_AUTH: "missing" });
    expect(await provider.status?.({ launch: unauthenticated.launch })).toEqual({
      available: false,
      diagnostic: "Antigravity authentication failed. Run `agy` and sign in, then retry.",
    });
    const authenticated = await harness();
    expect(await provider.status?.({ launch: authenticated.launch })).toEqual({ available: true });
  });
  it("keys catalog caching by the complete effective launch without exposing env values", async () => {
    const h = await harness();
    const key = await provider.getCatalogCacheKey?.({ scope: "global", launch: h.launch });
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(
      await provider.getCatalogCacheKey?.({
        scope: "workspace",
        cwd: h.cwd,
        force: true,
        launch: h.launch,
      }),
    ).toBe(key);
    expect(
      await provider.getCatalogCacheKey?.({
        scope: "global",
        launch: { ...h.launch, args: [...h.launch.args, "changed"] },
      }),
    ).not.toBe(key);
    expect(
      await provider.getCatalogCacheKey?.({
        scope: "global",
        launch: { ...h.launch, env: { ...h.launch.env, HOME: "different" } },
      }),
    ).not.toBe(key);
  });
});

describe("process signal plans", () => {
  it.each(["SIGINT", "SIGTERM", "SIGKILL"] as const)("kills the Windows tree for %s", (signal) => {
    expect(signalPlan({ platform: "win32", pid: 123, signal })).toEqual({
      type: "tree",
      command: "taskkill",
      args: ["/PID", "123", "/T", "/F"],
    });
  });
  it.each(["SIGINT", "SIGTERM", "SIGKILL"] as const)(
    "preserves POSIX group signal %s",
    (signal) => {
      expect(signalPlan({ platform: "linux", pid: 123, signal })).toEqual({
        type: "group",
        pid: -123,
        signal,
      });
    },
  );
});

describe("image prompts", () => {
  it.each(["session", "connection"])(
    "encodes mixed content as private session files and cleans up on %s close",
    async (close) => {
      const h = await harness();
      await h.open();
      const png = await readFile(
        new URL("../test/fixtures/image-file-external.png", import.meta.url),
      );
      const jpeg = Buffer.from("image file bytes");
      await h.completed(
        await h.message([
          { type: "text", text: "Describe these images." },
          { type: "image", data: png.toString("base64"), mimeType: "image/png" },
          { type: "text", text: "Compare them." },
          { type: "image", data: jpeg.toString("base64"), mimeType: "image/jpeg" },
        ]),
      );
      const sent = (await h.records()).find((entry) => entry.input).input.message.content;
      const lines = sent.split("\n");
      const pngPath = lines[3].slice("Attached image: ".length);
      const jpegPath = lines[5].slice("Attached image: ".length);
      expect(sent).toBe(
        `SYSTEM PREFIX\n\nDescribe these images.\nAttached image: ${pngPath}\nCompare them.\nAttached image: ${jpegPath}`,
      );
      expect(path.isAbsolute(pngPath)).toBe(true);
      expect(path.extname(pngPath)).toBe(".png");
      expect(path.extname(jpegPath)).toBe(".jpg");
      expect(path.dirname(pngPath)).toBe(path.dirname(jpegPath));
      expect(path.dirname(pngPath)).not.toBe(h.cwd);
      expect(await readFile(pngPath)).toEqual(png);
      expect(await readFile(jpegPath)).toEqual(jpeg);
      if (process.platform !== "win32") {
        expect((await stat(path.dirname(pngPath))).mode & 0o777).toBe(0o700);
        expect((await stat(pngPath)).mode & 0o777).toBe(0o600);
        expect((await stat(jpegPath)).mode & 0o777).toBe(0o600);
      }
      const args = (await h.records()).find((entry) => entry.args?.includes("--input-format")).args;
      expect(args.filter((arg: string) => arg === "--add-dir")).toHaveLength(1);
      if (close === "connection") await h.connection.close();
      else await h.request({ type: "session.close", requestId: "close-images", sessionId: "s" });
      await expect(stat(path.dirname(pngPath))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("keeps image-only prompts in distinct session directories until each session closes", async () => {
    const h = await harness();
    await h.open();
    await h.open(undefined, "other");
    const content: ProviderContent[] = [
      { type: "image", data: "aW1hZ2U=", mimeType: "image/webp" },
    ];
    await h.completed(await h.message(content));
    await h.completed(await h.message(content));
    await h.completed(await h.message(content, "other"));
    const paths = (await h.records())
      .filter((entry) => entry.input)
      .map((entry) => entry.input.message.content.split("Attached image: ")[1]);
    expect(new Set(paths).size).toBe(3);
    expect(path.dirname(paths[0])).toBe(path.dirname(paths[1]));
    expect(path.dirname(paths[0])).not.toBe(path.dirname(paths[2]));
    expect(paths.every((file: string) => path.extname(file) === ".webp")).toBe(true);
    await h.request({ type: "session.close", requestId: "close-first", sessionId: "s" });
    await expect(stat(path.dirname(paths[0]))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(paths[2], "utf8")).toBe("image");
    await h.connection.close();
    await expect(stat(path.dirname(paths[2]))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a non-image MIME type before writing to native stdin", async () => {
    const h = await harness();
    await h.open();
    const id = await h.message([{ type: "image", data: "dGV4dA==", mimeType: "text/plain" }]);
    expect(
      h.events.find(
        (event) => event.type === "session.prompt_result" && event.clientMessageId === id,
      ),
    ).toMatchObject({
      result: { type: "failed", error: { message: expect.stringContaining("image MIME type") } },
    });
    expect((await h.records()).filter((entry) => entry.input)).toHaveLength(0);
  });
});
