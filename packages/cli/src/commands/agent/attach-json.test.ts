import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createTestPaseoDaemon } from "../../../../server/src/server/test-utils/paseo-daemon.js";
import { DaemonClient } from "../../../../server/src/server/test-utils/daemon-client.js";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { runJsonAttach, type JsonAttachPort } from "./attach.js";

const items: AgentTimelineItem[] = [
  { type: "user_message", text: "hello\n한국어", messageId: "u1", clientMessageId: "client1" },
  { type: "assistant_message", text: "answer", messageId: "a1" },
  { type: "reasoning", text: "thinking" },
  {
    type: "tool_call",
    callId: "c1",
    name: "example",
    status: "completed",
    error: null,
    detail: { type: "unknown", input: { x: [1, true, null] }, output: { result: "ok" } },
    metadata: { nested: { value: "retained" } },
  },
  { type: "todo", items: [{ text: "task", completed: false }] },
  { type: "error", message: "timeline error" },
  { type: "notification", level: "warning", message: "notice" },
  { type: "compaction", status: "completed", trigger: "auto", preTokens: 123 },
  {
    type: "plugin",
    id: "p1",
    pluginId: "example",
    kind: "card",
    version: 1,
    data: { x: [true, null] },
  },
  { type: "user_message", text: "ten" },
  { type: "user_message", text: "eleven" },
];

describe("attach JSON", () => {
  it.each([
    ["attach", "--json"],
    ["attach", "$id", "--json"],
    ["agent", "attach", "--json"],
    ["attach", "--format", "json"],
    ["agent", "attach", "--format", "json"],
    ["attach", "-o", "json"],
    ["--json", "attach"],
    ["--format", "json", "agent", "attach"],
    ["attach", "--json", "--format", "table"],
  ])(
    "streams history and live items with selectors %j",
    async (...args) => {
      const daemon = await createTestPaseoDaemon();
      const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
      let child: ReturnType<typeof spawn> | undefined;
      try {
        await client.connect();
        const agent = await client.createAgent({ provider: "claude", cwd: daemon.paseoHome });
        for (const item of items)
          await daemon.daemon.agentManager.appendTimelineItem(agent.id, item);
        const history = await client.fetchAgentTimeline(agent.id, {
          direction: "tail",
          limit: 0,
          projection: "projected",
        });
        let stdout = "";
        let stderr = "";
        child = spawn(
          process.execPath,
          [
            "--conditions=source",
            "--import",
            "tsx",
            fileURLToPath(new URL("../../index.ts", import.meta.url)),
            "--host",
            `127.0.0.1:${daemon.port}`,
            ...args.map((arg) => (arg === "$id" ? agent.id : arg)),
            ...(args.includes("$id") ? [] : [agent.id]),
          ],
          {
            env: { ...process.env, NODE_NO_WARNINGS: "1", PASEO_HOME: daemon.paseoHome },
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
        const exited = once(child, "close");
        child.stdout?.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        await expect.poll(() => stderr, { timeout: 60_000 }).toContain("Attached to agent");
        expect(
          stdout
            .trimEnd()
            .split("\n")
            .map((line) => JSON.parse(line)),
        ).toEqual(history.entries.map((entry) => entry.item));
        expect(history.entries.length).toBeGreaterThan(10);
        child.stdin?.end();
        const live = { type: "user_message", text: "live\nfragment" } satisfies AgentTimelineItem;
        await daemon.daemon.agentManager.appendTimelineItem(agent.id, live);
        await expect.poll(() => stdout, { timeout: 10_000 }).toContain(`${JSON.stringify(live)}\n`);
        child.kill("SIGINT");
        expect(await exited).toEqual([0, null]);
        expect(
          stdout
            .trimEnd()
            .split("\n")
            .map((line) => JSON.parse(line)),
        ).toEqual([...history.entries.map((entry) => entry.item), live]);
      } finally {
        if (child?.exitCode === null) {
          child.kill("SIGTERM");
          await once(child, "close");
        }
        await client.close();
        await daemon.close();
      }
    },
    120_000,
  );
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function jsonHarness() {
  const stop = deferred<void>();
  const attached = deferred<void>();
  const subscribed = deferred<void>();
  const output: string[] = [];
  const notices: string[] = [];
  let handler!: Parameters<JsonAttachPort["subscribe"]>[0];
  let closed = 0;
  let released = 0;
  let signal: AbortSignal | undefined;
  const port: JsonAttachPort = {
    history: async () => [],
    subscribe(callback) {
      handler = callback;
      subscribed.resolve();
      return Object.assign(
        () => {
          released++;
        },
        { ready: Promise.resolve() },
      );
    },
    close: async () => {
      closed++;
    },
    wait: (abort) => {
      signal = abort;
      return stop.promise;
    },
    write: (chunk) => {
      output.push(chunk);
    },
    notice: (message) => {
      notices.push(message);
      if (message.startsWith("Attached")) attached.resolve();
    },
  };
  return {
    port,
    stop,
    attached,
    subscribed,
    output,
    notices,
    emit: (message: Parameters<typeof handler>[0]) => handler(message),
    cleanup: () => ({ closed, released, aborted: signal?.aborted }),
  };
}

describe("JSON attach lifecycle port", () => {
  it("keeps empty history silent while attached and cleans up", async () => {
    const h = jsonHarness();
    const running = runJsonAttach(h.port, "agent-id");
    await h.attached.promise;
    expect(h.output).toEqual([]);
    h.stop.resolve();
    await running;
    expect(h.cleanup()).toEqual({ closed: 1, released: 1, aborted: true });
  });

  it("routes lifecycle diagnostics separately from timeline error items", async () => {
    const h = jsonHarness();
    const running = runJsonAttach(h.port, "agent-id");
    await h.attached.promise;
    // The renderer reads only the discriminator for replacement/restored.
    h.emit({ type: "agent.timeline.replacement" } as Parameters<typeof h.emit>[0]);
    h.emit({
      type: "agent.timeline.subscription_restored",
      payload: { agentId: "agent-id", subscriptionId: "s" },
    });
    h.emit({
      type: "agent.timeline.error",
      payload: { agentId: "agent-id", error: "observation failed" },
    });
    const emitEvent = (event: import("@getpaseo/protocol/messages").AgentStreamEventPayload) =>
      h.emit({ type: "agent_stream", payload: { event } } as Parameters<typeof h.emit>[0]);
    emitEvent({ type: "timeline", item: { type: "error", message: "item failed" } });
    emitEvent({
      type: "turn_failed",
      error: "turn failed",
    } as import("@getpaseo/protocol/messages").AgentStreamEventPayload);
    emitEvent({
      type: "permission_resolved",
      resolution: { behavior: "allow" },
    } as import("@getpaseo/protocol/messages").AgentStreamEventPayload);
    h.stop.resolve();
    await running;
    expect(h.output).toEqual(['{"type":"error","message":"item failed"}\n']);
    expect(h.notices).toEqual([
      "Fetching history for agent agent-i...",
      "(Press Ctrl+C to detach)\n",
      "Attached to agent agent-i.",
      "\n[Timeline replaced; earlier output is no longer current]",
      "\n[Reconnected; live output resumed. Events may have been missed.]",
      "Timeline observation stopped: observation failed",
      "\n\nDetaching from agent...",
    ]);
  });

  it("preserves repeated tool states and assistant fragments as separate records", async () => {
    const h = jsonHarness();
    const received: AgentTimelineItem[] = [
      items[3]!,
      items[3]!,
      { type: "assistant_message", text: "frag", messageId: "m" },
      { type: "assistant_message", text: "ment", messageId: "m" },
    ];
    const running = runJsonAttach(h.port, "id");
    await h.attached.promise;
    for (const item of received)
      h.emit({ type: "agent_stream", payload: { event: { type: "timeline", item } } } as Parameters<
        typeof h.emit
      >[0]);
    h.stop.resolve();
    await running;
    expect(h.output).toEqual(received.map((item) => `${JSON.stringify(item)}\n`));
  });

  it("warns on history rejection and continues subscribing", async () => {
    const h = jsonHarness();
    h.port.history = async () => {
      throw new Error("history failed");
    };
    const running = runJsonAttach(h.port, "id");
    await h.attached.promise;
    h.stop.resolve();
    await running;
    expect(h.notices).toContain("Warning: failed to fetch existing timeline");
    expect(h.output).toEqual([]);
    expect(h.cleanup()).toEqual({ closed: 1, released: 1, aborted: true });
  });

  it("cleans up when readiness rejects", async () => {
    const h = jsonHarness();
    const subscribe = h.port.subscribe;
    h.port.subscribe = (handler) =>
      Object.assign(subscribe(handler), { ready: Promise.reject(new Error("ready failed")) });
    await expect(runJsonAttach(h.port, "id")).rejects.toThrow("ready failed");
    expect(h.output).toEqual([]);
    expect(h.cleanup()).toEqual({ closed: 1, released: 1, aborted: true });
  });

  it.each(["history", "readiness"])(
    "stops during delayed %s without waiting for setup",
    async (phase) => {
      const h = jsonHarness();
      const pending = deferred<AgentTimelineItem[]>();
      if (phase === "history") h.port.history = () => pending.promise;
      else
        h.port.subscribe = () => {
          h.subscribed.resolve();
          return Object.assign(() => {}, { ready: new Promise<void>(() => {}) });
        };
      const running = runJsonAttach(h.port, "id");
      if (phase === "readiness") await h.subscribed.promise;
      h.stop.resolve();
      await running;
      expect(h.output).toEqual([]);
      expect(h.cleanup().closed).toBe(1);
      expect(h.cleanup().aborted).toBe(true);
    },
  );
});

it.each(["empty", "human", "history-pipe", "live-pipe"])(
  "attach child lifecycle: %s",
  async (mode) => {
    const daemon = await createTestPaseoDaemon();
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    let child: ReturnType<typeof spawn> | undefined;
    try {
      await client.connect();
      const agent = await client.createAgent({ provider: "claude", cwd: daemon.paseoHome });
      const item = { type: "user_message", text: "human baseline" } satisfies AgentTimelineItem;
      if (mode === "human" || mode === "history-pipe")
        await daemon.daemon.agentManager.appendTimelineItem(agent.id, item);
      let stdout = "";
      let stderr = "";
      child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          fileURLToPath(new URL("../../index.ts", import.meta.url)),
          "--host",
          `127.0.0.1:${daemon.port}`,
          "attach",
          agent.id,
          ...(mode === "human" ? [] : ["--json"]),
        ],
        {
          env: { ...process.env, NODE_NO_WARNINGS: "1", PASEO_HOME: daemon.paseoHome },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      const exited = once(child, "close");
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      if (mode === "history-pipe") child.stdout?.destroy();
      else {
        await expect
          .poll(
            () => {
              if (child?.exitCode !== null)
                throw new Error(`CLI exited before attachment: ${stderr}`);
              return mode === "human" ? stdout : stderr;
            },
            { timeout: 60_000 },
          )
          .toContain("Attached to agent");
        if (mode === "live-pipe") {
          child.stdout?.destroy();
          await daemon.daemon.agentManager.appendTimelineItem(agent.id, item);
        } else {
          if (mode === "empty") expect(stdout).toBe("");
          child.kill("SIGTERM");
        }
      }
      expect(await exited).toEqual([0, null]);
      if (mode === "human") {
        const short = agent.id.substring(0, 7);
        expect(stdout).toBe(
          `Fetching history for agent ${short}...\n(Press Ctrl+C to detach)\n\n\n[User] human baseline\nAttached to agent ${short}.\n\n\nDetaching from agent...\n`,
        );
        expect(stderr).toBe("");
      }
      expect(stderr).not.toContain("EPIPE");
    } finally {
      if (child?.exitCode === null) {
        child.kill("SIGTERM");
        await once(child, "close");
      }
      await client.close();
      await daemon.close();
    }
  },
  120_000,
);

it.each([
  ["history", "SIGINT"],
  ["history", "SIGTERM"],
  ["readiness", "SIGINT"],
  ["readiness", "SIGTERM"],
])(
  "stops a child during delayed %s with %s",
  async (phase, signal) => {
    const moduleUrl = new URL("./attach.ts", import.meta.url).href;
    const script = `
    import { runJsonAttach } from ${JSON.stringify(moduleUrl)};
    const listeners = () => [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM"), process.stdout.listenerCount("error")];
    const before = JSON.stringify(listeners());
    const keepAlive = setInterval(() => {}, 1000);
    await runJsonAttach({
      history: () => ${phase === "history" ? "new Promise(() => {})" : "Promise.resolve([])"},
      subscribe: () => { process.stderr.write("WAITING_READY\\n"); return Object.assign(() => {}, { ready: new Promise(() => {}) }); },
      close: async () => { clearInterval(keepAlive); },
    }, "fixture-id");
    if (JSON.stringify(listeners()) !== before) throw new Error("leaked stop listeners");
  `;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    const exited = once(child, "close");
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    try {
      await expect
        .poll(() => stderr, { timeout: 60_000 })
        .toContain(phase === "history" ? "Fetching history" : "WAITING_READY");
      child.kill(signal as NodeJS.Signals);
      expect(await exited).toEqual([0, null]);
      expect(stdout).toBe("");
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await exited;
      }
    }
  },
  90_000,
);
