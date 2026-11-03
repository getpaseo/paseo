import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { DaemonClient } from "../test-utils/daemon-client.js";

// A real daemon and CLI with a deterministic provider emitting two text chunks.
// The live Claude reproduction is recorded in the PR; this locks its CLI behavior.
test("logs --follow preserves the same assistant text as one-shot logs", async () => {
  const daemon = await createTestPaseoDaemon();
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  let follow: ReturnType<typeof spawn> | undefined;
  let stdout = "";
  let stderr = "";
  try {
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    const agent = await client.createAgent({
      provider: "claude",
      cwd: daemon.paseoHome,
      title: "Follow transcript regression",
      modeId: "bypassPermissions",
    });
    follow = spawn(
      process.execPath,
      [
        "--conditions=source",
        "--import",
        "tsx",
        fileURLToPath(new URL("../../../../cli/src/index.ts", import.meta.url)),
        "--host",
        `127.0.0.1:${daemon.port}`,
        "logs",
        "--follow",
        agent.id,
        "--tail",
        "0",
        "--filter",
        "assistant_message",
      ],
      {
        env: { ...process.env, PASEO_HOME: daemon.paseoHome },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const exited = once(follow, "exit");
    follow.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    follow.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    await expect
      .poll(
        () => {
          if (follow?.exitCode !== null) {
            throw new Error(`CLI exited before following logs: ${stderr}`);
          }
          return stdout;
        },
        { timeout: 20_000 },
      )
      .toContain("Following logs");
    await client.sendMessage(agent.id, "respond with exactly: paseo-pr-cycle 한국어 보고서");
    await client.waitForAgentUpsert(agent.id, (snapshot) => snapshot.status === "idle", 20_000);
    const transcript = await client.fetchAgentTimeline(agent.id, {
      direction: "tail",
      limit: 100,
      projection: "projected",
    });
    const assistantText = transcript.entries
      .filter((row) => row.item.type === "assistant_message")
      .map((row) => (row.item.type === "assistant_message" ? row.item.text : ""))
      .join("");
    expect(assistantText).not.toBe("");
    // Completion closes the message while follow mode is still running.
    // Then stop through the CLI's normal signal path.
    await expect.poll(() => stdout, { timeout: 10_000 }).toContain(`${assistantText.trim()}\n`);
    follow.kill("SIGINT");
    await exited;
    const output = stdout.slice(stdout.indexOf("---\n") + 4).trim();
    expect(output, stderr).toBe(assistantText.trim());
  } finally {
    follow?.kill("SIGTERM");
    await client.close();
    await daemon.close();
  }
}, 60_000);

test("omitted after limit pages forward while explicit zero preserves complete CLI history", async () => {
  const daemon = await createTestPaseoDaemon();
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    const agent = await client.createAgent({ provider: "claude", cwd: daemon.paseoHome });
    const initial = await client.fetchAgentTimeline(agent.id, { direction: "tail", limit: 0 });
    const cursor = { epoch: initial.epoch, seq: initial.window.maxSeq };
    for (let index = 0; index < 451; index++) {
      await daemon.daemon.agentManager.appendTimelineItem(agent.id, {
        type: "user_message",
        text: String(index),
      });
    }
    const first = await client.fetchAgentTimeline(agent.id, { direction: "after", cursor });
    expect(first.entries).toHaveLength(200);
    expect(first.hasNewer).toBe(true);
    expect(first.endCursor).toEqual({ epoch: cursor.epoch, seq: cursor.seq + 200 });
    const second = await client.fetchAgentTimeline(agent.id, {
      direction: "after",
      cursor: first.endCursor!,
    });
    const third = await client.fetchAgentTimeline(agent.id, {
      direction: "after",
      cursor: second.endCursor!,
    });
    expect(second.entries).toHaveLength(200);
    expect(third.entries).toHaveLength(51);
    expect(third.hasNewer).toBe(false);
    expect(
      [...first.entries, ...second.entries, ...third.entries].map((entry) => entry.item),
    ).toEqual(
      Array.from({ length: 451 }, (_, index) => ({ type: "user_message", text: String(index) })),
    );
    const allAfter = await client.fetchAgentTimeline(agent.id, {
      direction: "after",
      cursor,
      limit: 0,
    });
    const allTail = await client.fetchAgentTimeline(agent.id, { direction: "tail", limit: 0 });
    expect(allAfter.entries).toHaveLength(451);
    expect(allAfter.hasNewer).toBe(false);
    expect(allTail.entries).toHaveLength(initial.entries.length + 451);
  } finally {
    await client.close();
    await daemon.close();
  }
}, 60_000);

test.each([
  { label: "--json", flags: ["--json"] },
  { label: "--format json", flags: ["--format", "json"] },
])(
  "logs --follow $label keeps history, live items and notices on their channels",
  async ({ flags }) => {
    await mkdir(".artifacts", { recursive: true });
    const paseoHomeRoot = await mkdtemp(resolve(".artifacts/logs-follow-json-"));
    const staticDir = join(paseoHomeRoot, "static");
    await mkdir(staticDir);
    const daemon = await createTestPaseoDaemon({ paseoHomeRoot, staticDir });
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    let follow: ReturnType<typeof spawn> | undefined;
    let stdout = "";
    let stderr = "";
    try {
      await client.connect();
      const agent = await client.createAgent({ provider: "claude", cwd: daemon.paseoHome });
      const history = [
        { type: "user_message" as const, text: "Saved JSON prompt" },
        { type: "assistant_message" as const, text: "Saved JSON reply", messageId: "saved" },
      ];
      for (const item of history)
        await daemon.daemon.agentManager.appendTimelineItem(agent.id, item);
      follow = spawn(
        process.execPath,
        [
          "--conditions=source",
          "--import",
          "tsx",
          fileURLToPath(new URL("../../../../cli/src/index.ts", import.meta.url)),
          "--host",
          `127.0.0.1:${daemon.port}`,
          "logs",
          agent.id,
          "--follow",
          ...flags,
        ],
        {
          env: { ...process.env, PASEO_HOME: daemon.paseoHome },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const exited = once(follow, "exit");
      follow.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      follow.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      await expect
        .poll(
          () => {
            if (follow?.exitCode !== null)
              throw new Error(`CLI exited before following logs: ${stderr}`);
            return stdout + stderr;
          },
          { timeout: 20_000 },
        )
        .toContain("Following logs");
      const live = {
        type: "assistant_message" as const,
        text: "Live JSON reply",
        messageId: "live",
      };
      await daemon.daemon.agentManager.appendTimelineItem(agent.id, live);
      await expect.poll(() => stdout, { timeout: 10_000 }).toContain(live.text);
      follow.kill("SIGINT");
      await exited;
      expect(
        stdout
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      ).toEqual([...history, live]);
      expect(stderr).toContain("Following logs");
      expect(stdout).not.toContain("Following logs");
    } finally {
      follow?.kill("SIGTERM");
      await client.close();
      await daemon.close();
    }
  },
  60_000,
);

test.each([
  { label: "--json", command: ["logs"], flags: ["--json"] },
  { label: "--format json", command: ["agent", "logs"], flags: ["--format", "json"] },
])(
  "logs --follow $label exits when stdout closes before saved history is written",
  async ({ command, flags }) => {
    await mkdir(".artifacts", { recursive: true });
    const paseoHomeRoot = await mkdtemp(resolve(".artifacts/logs-follow-closed-"));
    const staticDir = join(paseoHomeRoot, "static");
    await mkdir(staticDir);
    const daemon = await createTestPaseoDaemon({ paseoHomeRoot, staticDir });
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    let follow: ReturnType<typeof spawn> | undefined;
    let stderr = "";
    try {
      await client.connect();
      // No turn is started: the saved history must trigger shutdown on its own.
      const agent = await client.createAgent({ provider: "claude", cwd: daemon.paseoHome });
      await daemon.daemon.agentManager.appendTimelineItem(agent.id, {
        type: "assistant_message",
        text: "Saved reply before the reader closes",
        messageId: "saved",
      });
      follow = spawn(
        process.execPath,
        [
          "--conditions=source",
          "--import",
          "tsx",
          fileURLToPath(new URL("../../../../cli/src/index.ts", import.meta.url)),
          "--host",
          `127.0.0.1:${daemon.port}`,
          ...command,
          agent.id,
          "--follow",
          ...flags,
        ],
        {
          env: { ...process.env, PASEO_HOME: daemon.paseoHome },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const exited = once(follow, "exit");
      follow.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      follow.stdout?.destroy();
      await expect.poll(() => follow?.exitCode, { timeout: 10_000 }).toBe(0);
      expect(await exited, stderr).toEqual([0, null]);
    } finally {
      follow?.kill("SIGKILL");
      await client.close();
      await daemon.close();
    }
  },
  30_000,
);

// Windows kill("SIGINT") force-terminates rather than delivering a console interrupt.
test.skipIf(process.platform === "win32")(
  "logs --follow stops on SIGINT while subscription startup is waiting",
  async () => {
    await mkdir(".artifacts", { recursive: true });
    const paseoHomeRoot = await mkdtemp(resolve(".artifacts/logs-follow-startup-"));
    const staticDir = join(paseoHomeRoot, "static");
    await mkdir(staticDir);
    const daemon = await createTestPaseoDaemon({ paseoHomeRoot, staticDir });
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    const proxy = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await once(proxy, "listening");
    const address = proxy.address();
    if (typeof address === "string" || address === null) throw new Error("Missing proxy port");
    const upstreams: WebSocket[] = [];
    let waitingForSubscription = false;
    proxy.on("connection", (downstream) => {
      const upstream = new WebSocket(`ws://127.0.0.1:${daemon.port}/ws`);
      upstreams.push(upstream);
      const connected = once(upstream, "open");
      downstream.on("message", async (data, binary) => {
        await connected;
        const frame = binary ? undefined : JSON.parse(data.toString());
        // Hold only the subscription request. All other traffic uses the real daemon.
        if (frame?.message?.type === "agent.timeline.set_subscription.request") {
          waitingForSubscription = true;
          return;
        }
        upstream.send(data, { binary });
      });
      upstream.on("message", (data, binary) => downstream.send(data, { binary }));
      downstream.on("close", () => upstream.close());
    });
    let follow: ReturnType<typeof spawn> | undefined;
    try {
      await client.connect();
      const agent = await client.createAgent({ provider: "claude", cwd: daemon.paseoHome });
      follow = spawn(
        process.execPath,
        [
          "--conditions=source",
          "--import",
          "tsx",
          fileURLToPath(new URL("../../../../cli/src/index.ts", import.meta.url)),
          "--host",
          `127.0.0.1:${address.port}`,
          "logs",
          agent.id,
          "--follow",
          "--json",
        ],
        {
          env: { ...process.env, PASEO_HOME: daemon.paseoHome },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      follow.stdout?.resume();
      follow.stderr?.resume();
      const exited = once(follow, "exit");
      await expect.poll(() => waitingForSubscription, { timeout: 10_000 }).toBe(true);
      follow.kill("SIGINT");
      await expect.poll(() => follow?.exitCode, { timeout: 5_000 }).toBe(0);
      expect(await exited).toEqual([0, null]);
    } finally {
      if (follow && follow.exitCode === null && follow.signalCode === null) {
        follow.kill("SIGKILL");
        await once(follow, "exit");
      }
      for (const upstream of upstreams) upstream.terminate();
      for (const downstream of proxy.clients) downstream.terminate();
      await new Promise<void>((done) => proxy.close(() => done()));
      await client.close();
      await daemon.close();
    }
  },
  30_000,
);
