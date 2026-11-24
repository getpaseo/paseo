import { test } from "vitest";
import assert from "node:assert";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { Readable } from "node:stream";
import { join } from "node:path";
import { createDaemonTestContext } from "./test-utils/daemon-test-context.js";
import { createTestAgentClients } from "./test-utils/fake-agent-client.js";
import type { AgentStreamEvent } from "@getpaseo/protocol/agent-types";

interface CliResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}
type CliProcess = Promise<CliResult> & { stdout: Readable; kill: (signal: NodeJS.Signals) => void };

function waitForCliOutput(child: CliProcess, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes(text)) {
        cleanup();
        resolve();
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`CLI did not print ${text}:\n${output}`));
    }, 20_000);
    child.stdout.on("data", onData);
    void child.then(
      (result) => {
        cleanup();
        return reject(new Error(`CLI exited before ${text}:\n${result.stderr}`));
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

test("logs --since filters history and live output through the CLI and daemon", async () => {
  const cliHome = await mkdtemp(join(tmpdir(), "paseo-logs-cli-home-"));
  const port = 1; // Invalid dates must fail before trying this unavailable endpoint.
  const runLocalPaseo = (
    args: string[],
    env: NodeJS.ProcessEnv = {},
    cwd = cliHome,
  ): CliProcess => {
    const child = spawn(
      process.execPath,
      [
        "--no-warnings",
        "--conditions=source",
        "--import",
        import.meta.resolve("tsx"),
        fileURLToPath(new URL("../../../cli/src/index.ts", import.meta.url)),
        ...args,
      ],
      {
        cwd,
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(([key]) => !key.startsWith("PASEO_")),
          ),
          ...env,
          HOME: cliHome,
          USERPROFILE: cliHome,
        },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 25_000,
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const done = new Promise<CliResult>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
    });
    return Object.assign(done, {
      stdout: child.stdout,
      kill: (signal: NodeJS.Signals) => {
        child.kill(signal);
      },
    });
  };
  // Follow assertions check output; Windows forcibly terminates Node on SIGINT.
  try {
    console.log("--since filters logs through the real CLI and daemon");
    const historyEvents: AgentStreamEvent[] = [];
    const ctx = await createDaemonTestContext({
      agentClients: createTestAgentClients({ historyEvents }),
    });
    try {
      const agent = await ctx.client.createAgent({
        provider: "codex",
        cwd: ctx.daemon.paseoHome,
        title: "logs since",
      });
      const manager = ctx.daemon.daemon.agentManager;
      await manager.appendTimelineItem(agent.id, { type: "user_message", text: "OLD_USER" });
      await manager.appendTimelineItem(agent.id, { type: "assistant_message", text: "OLD_REPLY" });
      const host = `127.0.0.1:${ctx.daemon.port}`;
      const logs = (args: string[]) =>
        runLocalPaseo(["--host", host, ...args], {}, ctx.daemon.paseoHome);

      const baseline = await logs(["logs", agent.id]);
      assert.strictEqual(baseline.exitCode, 0, baseline.stderr);
      assert.strictEqual(baseline.stdout, "[User] OLD_USER\nOLD_REPLY\n");

      for (const command of [["logs"], ["agent", "logs"]]) {
        const result = await logs([...command, agent.id, "--since", "2100-01-01T00:00:00Z"]);
        console.log(`paseo ${command.join(" ")} <id> --since 2100-01-01T00:00:00Z`);
        console.log(`exit=${result.exitCode}\nstdout:\n${result.stdout}stderr:\n${result.stderr}`);
        assert.strictEqual(result.exitCode, 0, result.stderr);
        assert.strictEqual(result.stdout, "No activity to display.\n");
      }

      const timeline = await ctx.client.fetchAgentTimeline(agent.id, {
        direction: "tail",
        limit: 0,
        projection: "projected",
      });
      const firstTimestamp = timeline.entries[0]?.timestamp;
      assert(firstTimestamp !== undefined, "the fixture should have timestamped activity");
      for (const since of ["2000-01-01T00:00:00Z", firstTimestamp]) {
        const result = await logs(["logs", agent.id, "--since", since]);
        assert.strictEqual(result.exitCode, 0, result.stderr);
        assert.strictEqual(result.stdout, baseline.stdout);
      }

      const offset = await logs(["logs", agent.id, "--since", "2100-01-01T08:00:00+08:00"]);
      assert.strictEqual(offset.exitCode, 0, offset.stderr);
      assert.strictEqual(offset.stdout, "No activity to display.\n");

      const tail = await logs([
        "logs",
        agent.id,
        "--since",
        "2000-01-01T00:00:00Z",
        "--filter",
        "text",
        "--tail",
        "1",
      ]);
      assert.strictEqual(tail.exitCode, 0, tail.stderr);
      assert.strictEqual(tail.stdout, "OLD_REPLY\n");

      const empty = await logs(["logs", agent.id, "--since", firstTimestamp, "--tail", "0"]);
      assert.strictEqual(empty.exitCode, 0, empty.stderr);
      assert.strictEqual(empty.stdout, "");

      for (const followArgs of [[], ["--follow"]]) {
        const invalid = await runLocalPaseo([
          "--host",
          `127.0.0.1:${port}`,
          "logs",
          "missing-agent",
          "--since",
          "not-a-date",
          "--json",
          ...followArgs,
        ]);
        assert.strictEqual(invalid.exitCode, 1, invalid.stderr);
        assert.strictEqual(invalid.stdout, "");
        assert.deepStrictEqual(JSON.parse(invalid.stderr), {
          error: {
            code: "INVALID_TIMESTAMP",
            message: "Invalid --since value: not-a-date",
            details: "Use a timestamp such as 2026-01-01T00:00:00Z.",
          },
        });
      }

      console.log("--since filters initial history in follow mode");
      const follow = logs(["logs", agent.id, "--follow", "--since", "2100-01-01T00:00:00Z"]);
      try {
        await waitForCliOutput(follow, "--- Following logs");
      } finally {
        await follow.kill("SIGINT");
      }
      const followed = await follow;
      console.log(`follow exit=${followed.exitCode}\nstdout:\n${followed.stdout}`);
      assert.strictEqual(followed.stdout.includes("OLD_USER"), false);
      assert.strictEqual(followed.stdout.includes("OLD_REPLY"), false);

      console.log("--since filters live events in follow mode");
      const futureFollow = logs([
        "agent",
        "logs",
        agent.id,
        "-f",
        "--tail",
        "0",
        "--since",
        "2100-01-01T00:00:00Z",
      ]);
      try {
        await waitForCliOutput(futureFollow, "--- Following logs");
        // A timestamped history replay follows the live item on the same socket.
        // Its visible output proves the CLI consumed the earlier item too.
        await Promise.all([
          waitForCliOutput(futureFollow, "AFTER_CUTOFF"),
          (async () => {
            await manager.appendTimelineItem(agent.id, {
              type: "user_message",
              text: "LIVE_BEFORE_CUTOFF",
            });
            historyEvents.push({
              type: "timeline",
              provider: "codex",
              timestamp: "2110-01-01T00:00:00Z",
              item: { type: "user_message", text: "AFTER_CUTOFF" },
            });
            await ctx.client.refreshAgent(agent.id);
          })(),
        ]);
      } finally {
        await futureFollow.kill("SIGINT");
      }
      const futureOutput = await futureFollow;
      console.log(`future follow exit=${futureOutput.exitCode}\nstdout:\n${futureOutput.stdout}`);
      assert.strictEqual(futureOutput.stdout.includes("LIVE_BEFORE_CUTOFF"), false);

      console.log("follow still prints live events after --since");
      const pastFollow = logs([
        "logs",
        agent.id,
        "--follow",
        "--tail",
        "0",
        "--filter",
        "text",
        "--since",
        "2000-01-01T00:00:00Z",
      ]);
      try {
        await waitForCliOutput(pastFollow, "--- Following logs");
        await Promise.all([
          // Wait for a later visible item to close the streamed reply.
          // Windows SIGINT forcibly exits without running shutdown handlers.
          waitForCliOutput(pastFollow, "[User] LIVE_AFTER_REPLY\n"),
          (async () => {
            await manager.appendTimelineItem(agent.id, { type: "user_message", text: "LIVE_USER" });
            await manager.appendTimelineItem(agent.id, {
              type: "assistant_message",
              text: "LIVE_REPLY",
            });
            await manager.appendTimelineItem(agent.id, {
              type: "user_message",
              text: "LIVE_AFTER_REPLY",
            });
          })(),
        ]);
      } finally {
        await pastFollow.kill("SIGINT");
      }
      const pastOutput = await pastFollow;
      console.log(`past follow exit=${pastOutput.exitCode}\nstdout:\n${pastOutput.stdout}`);
      assert(pastOutput.stdout.includes("[User] LIVE_USER\nLIVE_REPLY\n"), pastOutput.stdout);
    } finally {
      await ctx.cleanup();
    }
  } finally {
    await rm(cliHome, { recursive: true, force: true });
  }
}, 120_000);

test("one-shot logs preserve history order across pages", async () => {
  const ctx = await createDaemonTestContext();
  try {
    const proxy = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    const upstreams: WebSocket[] = [];
    try {
      await once(proxy, "listening");
      const address = proxy.address();
      if (!address || typeof address === "string") throw new Error("Missing proxy port");
      const requests: Array<{
        direction?: string;
        limit?: number;
        cursor?: { epoch: string; seq: number };
      }> = [];
      proxy.on("connection", (downstream) => {
        const upstream = new WebSocket(`ws://127.0.0.1:${ctx.daemon.port}/ws`);
        upstreams.push(upstream);
        const connected = once(upstream, "open");
        void connected.catch(() => {});
        downstream.on("error", () => {});
        upstream.on("error", () => {});
        downstream.on("message", async (data, binary) => {
          try {
            await connected;
          } catch {
            return;
          }
          if (upstream.readyState !== WebSocket.OPEN) return;
          try {
            const frame = binary ? undefined : JSON.parse(data.toString());
            if (frame?.message?.type === "fetch_agent_timeline_request") {
              requests.push({
                direction: frame.message.direction,
                limit: frame.message.limit,
                cursor: frame.message.cursor,
              });
            }
            upstream.send(data, { binary });
          } catch {
            downstream.terminate();
            upstream.terminate();
          }
        });
        upstream.on("message", (data, binary) => {
          if (downstream.readyState === WebSocket.OPEN) downstream.send(data, { binary });
        });
        upstream.on("close", () => downstream.terminate());
        downstream.on("close", () => upstream.terminate());
      });
      const agent = await ctx.client.createAgent({
        provider: "codex",
        cwd: ctx.daemon.paseoHome,
        title: "paged logs",
      });
      const manager = ctx.daemon.daemon.agentManager;
      for (let index = 0; index < 405; index++) {
        const text = `row-${String(index).padStart(3, "0")} ${"x".repeat(4096)}`;
        await manager.appendTimelineItem(
          agent.id,
          [0, 1, 210, 270, 330, 380].includes(index)
            ? { type: "user_message", text }
            : { type: "assistant_message", text, messageId: `message-${index}` },
        );
      }
      const epoch = manager.fetchTimeline(agent.id, { direction: "tail", limit: 1 }).epoch;
      const prefix = [
        "--no-warnings",
        "--conditions=source",
        "--import",
        import.meta.resolve("tsx"),
        fileURLToPath(new URL("../../../cli/src/index.ts", import.meta.url)),
        "--host",
        `127.0.0.1:${address.port}`,
        "agent",
        "logs",
        agent.id,
      ];
      const cases = [
        {
          flags: ["--tail", "5", "--json"],
          expected: Array.from({ length: 5 }, (_, i) => i + 400),
          json: true,
        },
        {
          flags: ["--tail", "5"],
          expected: Array.from({ length: 5 }, (_, i) => i + 400),
          json: false,
        },
        {
          flags: ["--tail", "205", "--json"],
          expected: Array.from({ length: 205 }, (_, i) => i + 200),
          json: true,
        },
        { flags: ["--json"], expected: Array.from({ length: 405 }, (_, i) => i), json: true },
        { flags: [], expected: Array.from({ length: 405 }, (_, i) => i), json: false },
        { flags: ["--tail", "0", "--json"], expected: [], json: true },
        { flags: ["--tail", "0"], expected: [], json: false },
        {
          flags: [
            "--filter",
            "user_message",
            "--tail",
            "5",
            "--since",
            "2000-01-01T00:00:00Z",
            "--json",
          ],
          expected: [1, 210, 270, 330, 380],
          json: true,
        },
        { flags: ["--since", "2100-01-01T00:00:00Z", "--json"], expected: [], json: true },
        { flags: ["--tail", "0", "--filter", "text", "--json"], expected: [], json: true },
        { flags: ["--tail", "0", "--since", "2000-01-01T00:00:00Z"], expected: [], json: false },
        {
          flags: ["--tail", "205"],
          expected: Array.from({ length: 205 }, (_, i) => i + 200),
          json: false,
        },
        {
          flags: ["--filter", "user_message", "--tail", "5", "--since", "2000-01-01T00:00:00Z"],
          expected: [1, 210, 270, 330, 380],
          json: false,
        },
      ];
      const observed: Array<typeof requests> = [];
      for (const entry of cases) {
        requests.length = 0;
        const { stdout, stderr } = await promisify(execFile)(
          process.execPath,
          [...prefix, ...entry.flags],
          {
            cwd: ctx.daemon.paseoHome,
            env: {
              ...Object.fromEntries(
                Object.entries(process.env).filter(([key]) => !key.startsWith("PASEO_")),
              ),
              HOME: ctx.daemon.paseoHome,
              USERPROFILE: ctx.daemon.paseoHome,
            },
            maxBuffer: 8 * 1024 * 1024,
            timeout: 30_000,
          },
        );
        const parsed = entry.json
          ? (JSON.parse(stdout) as { agentId: string; items: Array<{ text: string }> })
          : undefined;
        if (parsed) assert.strictEqual(parsed.agentId, agent.id);
        const rows = parsed
          ? parsed.items.map((item) => item.text.slice(0, 7))
          : [...stdout.matchAll(/row-\d{3}/g)].map((match) => match[0]);
        const expected = entry.expected.map((i) => `row-${String(i).padStart(3, "0")}`);
        console.log(
          `paseo agent logs <id> ${entry.flags.join(" ")}: exit=0 count=${rows.length} first=${rows[0] ?? "-"} last=${rows.at(-1) ?? "-"} requests=${JSON.stringify(requests)} stderr=${JSON.stringify(stderr)}`,
        );
        assert.deepStrictEqual(rows, expected);
        assert.strictEqual(stderr, "");
        if (!entry.json) {
          const expectedText = entry.expected
            .map(
              (i) =>
                `${[0, 1, 210, 270, 330, 380].includes(i) ? "[User] " : ""}row-${String(i).padStart(3, "0")} ${"x".repeat(4096)}\n`,
            )
            .join("");
          assert.strictEqual(stdout, expectedText);
        }
        observed.push([...requests]);
      }
      assert.deepStrictEqual(observed[0], [{ direction: "tail", limit: 5, cursor: undefined }]);
      for (const index of [1, 2, 3, 4, 7, 8, 11, 12]) {
        assert(observed[index].length >= 2);
        assert.strictEqual(observed[index][0].direction, "tail");
        assert.strictEqual(observed[index][0].cursor, undefined);
        assert(
          observed[index].every(
            (request) => request.limit !== undefined && request.limit > 0 && request.limit <= 200,
          ),
        );
        assert(
          observed[index]
            .slice(1)
            .every((request) => request.direction === "before" && request.cursor !== undefined),
        );
        const cursors = observed[index].slice(1).map((request) => request.cursor!);
        assert(cursors.every((cursor) => cursor.epoch === epoch));
        assert(cursors.every((cursor, i) => i === 0 || cursor.seq < cursors[i - 1].seq));
      }
      for (const index of [1, 3, 4, 8, 11, 12]) assert(observed[index].length >= 3);
      assert.strictEqual(observed[2].length, 2);
      assert.deepStrictEqual(observed[5], []);
      assert.deepStrictEqual(observed[6], []);
      assert.deepStrictEqual(observed[9], []);
      assert.deepStrictEqual(observed[10], []);
    } finally {
      for (const downstream of proxy.clients) downstream.terminate();
      for (const upstream of upstreams) upstream.terminate();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  } finally {
    await ctx.cleanup();
  }
}, 240_000);

test("text tail retains older items when curation merges across turns", async () => {
  const historyEvents: AgentStreamEvent[] = [
    {
      type: "timeline",
      provider: "codex",
      timestamp: "2026-01-01T00:00:00Z",
      turnId: "t1",
      item: { type: "user_message", text: "u1" },
    },
    {
      type: "timeline",
      provider: "codex",
      timestamp: "2026-01-01T00:00:01Z",
      turnId: "t1",
      item: { type: "reasoning", text: "r1" },
    },
    {
      type: "timeline",
      provider: "codex",
      timestamp: "2026-01-01T00:00:02Z",
      turnId: "t2",
      item: { type: "reasoning", text: "r2" },
    },
  ];
  const agentClients = createTestAgentClients({ historyEvents });
  let publish: ((event: AgentStreamEvent) => void) | undefined;
  const fake = agentClients.codex;
  const createSession = fake.createSession.bind(fake);
  fake.createSession = async (...args) => {
    const session = await createSession(...args);
    const subscribe = session.subscribe.bind(session);
    session.subscribe = (listener) => {
      publish = listener;
      return subscribe(listener);
    };
    return session;
  };
  const ctx = await createDaemonTestContext({ agentClients });
  try {
    const agent = await ctx.client.createAgent({ provider: "codex", cwd: ctx.daemon.paseoHome });
    assert(publish);
    for (const event of historyEvents) publish(event);
    await ctx.daemon.daemon.agentManager.flush();
    await ctx.daemon.daemon.agentManager.flush();
    const timeline = await ctx.client.fetchAgentTimeline(agent.id, {
      direction: "tail",
      limit: 0,
      projection: "projected",
    });
    assert.deepStrictEqual(
      timeline.entries.map((entry) => [entry.turnId, entry.item]),
      [
        ["t1", { type: "user_message", text: "u1" }],
        ["t1", { type: "reasoning", text: "r1" }],
        ["t2", { type: "reasoning", text: "r2" }],
      ],
    );
    const args = [
      "--no-warnings",
      "--conditions=source",
      "--import",
      import.meta.resolve("tsx"),
      fileURLToPath(new URL("../../../cli/src/index.ts", import.meta.url)),
      "--host",
      `127.0.0.1:${ctx.daemon.port}`,
      "logs",
      agent.id,
      "--tail",
      "2",
    ];
    const { stdout, stderr } = await promisify(execFile)(process.execPath, args, {
      cwd: ctx.daemon.paseoHome,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !key.startsWith("PASEO_")),
        ),
        HOME: ctx.daemon.paseoHome,
        USERPROFILE: ctx.daemon.paseoHome,
      },
      timeout: 30_000,
    });
    console.log(
      `paseo logs <id> --tail 2: exit=0 stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`,
    );
    assert.strictEqual(stdout, "[User] u1\n[Thought] r1r2\n");
    assert.strictEqual(stderr, "");
  } finally {
    await ctx.cleanup();
  }
}, 120_000);
