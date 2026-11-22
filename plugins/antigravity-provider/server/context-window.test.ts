import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { tmpdir } from "node:os";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { afterEach, describe, expect, it } from "vitest";
import { createAntigravityProvider } from "./provider.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("effective Antigravity context", () => {
  const nativeId = "11111111-1111-4111-8111-111111111111";
  // agy 1.5.14 gen_metadata: [1, 9, 10, 4] window, [1, 19] requested model.
  const carbonRow = Buffer.from("0a114a06520420a0a41f9a0106636172626f6e", "hex"); // 512544
  const contextAgent = `
    const { createInterface } = require("node:readline");
    const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
    const config = model => [{
      type: "select", category: "model", id: "model", name: "Model", currentValue: model,
      options: [{ value: "carbon", name: "Carbon" }, { value: "neon", name: "Neon" }],
    }];
    const modes = { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] };
    createInterface({ input: process.stdin }).on("line", (line) => {
      const { id, method, params } = JSON.parse(line);
      const update = (update) => send({ method: "session/update", params: { sessionId: ${JSON.stringify(nativeId)}, update } });
      const usage = () => update({ sessionUpdate: "usage_update", used: 10458, size: 1048576 });
      switch (method) {
        case "initialize":
          send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true },
            agentInfo: { name: "Antigravity ACP Server", version: process.env.AGY_VERSION ?? "1.5.14" } } });
          break;
        case "session/load":
          usage();
          send({ id, result: { modes, configOptions: config(process.env.AGY_LOADED_MODEL ?? "carbon") } });
          update({ sessionUpdate: "available_commands_update", availableCommands: [] });
          break;
        case "session/set_config_option":
          send({ id, result: { configOptions: config(params.value) } });
          break;
        case "session/prompt":
          usage();
          send({ id, result: { stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 4, totalTokens: 104 } } });
          break;
      }
    });
  `;

  async function openContextSession(options?: {
    version?: string;
    linkedDb?: boolean;
    loadedModel?: string;
    unattributed?: boolean;
  }) {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-antigravity-context-"));
    directories.push(directory);
    const executable = path.join(directory, "agy.cjs");
    await writeFile(executable, contextAgent);
    const conversations = path.join(directory, "gemini", "custom", "conversations");
    await mkdir(conversations, { recursive: true });
    const candidate = path.join(conversations, `${nativeId}.db`);
    const dbPath = options?.linkedDb ? path.join(directory, "outside.db") : candidate;
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)");
    const put = db.prepare("INSERT OR REPLACE INTO gen_metadata VALUES (?, ?)");
    put.run(10, options?.unattributed ? Buffer.from("0a084a06520420a0a41f", "hex") : carbonRow);
    put.run(11, Buffer.from("0a00", "hex")); // later row without a window
    if (options?.linkedDb) await symlink(dbPath, candidate, "file");

    const connection = await createAntigravityProvider().connect({
      launch: {
        command: process.execPath,
        args: [executable, "acp", "--gemini_dir=gemini", "--app_data_dir", "custom"],
        env: {
          HOME: directory,
          USERPROFILE: directory,
          AGY_VERSION: options?.version ?? "1.5.14",
          AGY_LOADED_MODEL: options?.loadedModel ?? "carbon",
        },
      },
      versions: [1],
      capabilities: ["session.persistence", "session.configure", "prompt.message"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    return {
      events,
      put,
      usage: () => events.findLast((event) => event.type === "session.usage")?.usage,
      async open(model?: string) {
        await connection.send({
          type: "session.open",
          requestId: "open",
          sessionId: "test",
          history: "skip",
          persistence: { version: 1, data: { sessionId: nativeId } },
          config: { cwd: directory, env: {}, mcpServers: {}, settings: {}, persist: true, model },
        });
        await expect
          .poll(() =>
            events.find(
              (event) => event.type === "session.ready" || event.type === "request.failed",
            ),
          )
          .toMatchObject({ type: "session.ready" });
      },
      selectNeon: () =>
        connection.send({
          type: "session.configure",
          requestId: "model-switch",
          sessionId: "test",
          changes: { model: "neon" },
        }),
      prompt: () =>
        connection.send({
          type: "session.prompt",
          sessionId: "test",
          prompt: {
            clientMessageId: "prompt",
            delivery: "auto",
            input: { type: "message", content: [{ type: "text", text: "Reply briefly" }] },
          },
        }),
      async close() {
        await connection.close();
        db.close();
      },
    };
  }

  it("uses the newest eligible window at resume, then replaces it only with current model data", async () => {
    const session = await openContextSession();
    try {
      await session.open();
      expect(session.usage()).toMatchObject({
        contextWindowUsedTokens: 10458,
        contextWindowMaxTokens: 512544,
      });
      await session.selectNeon();
      await expect.poll(session.usage).toMatchObject({
        contextWindowUsedTokens: 10458,
        contextWindowMaxTokens: 1048576,
      });

      session.put.run(12, carbonRow); // Old generation arrives after the model switch.
      await session.prompt();
      await expect
        .poll(() => session.events)
        .toContainEqual(expect.objectContaining({ type: "session.turn", state: "completed" }));
      expect(session.usage()?.contextWindowMaxTokens).toBe(1048576);
      session.put.run(13, Buffer.from("0a0f4a06520420a08d069a01046e656f6e", "hex")); // 100000, Neon
      await expect.poll(session.usage).toMatchObject({
        contextWindowUsedTokens: 10458,
        contextWindowMaxTokens: 100000,
        inputTokens: 100,
        outputTokens: 4,
      });
    } finally {
      await session.close();
    }
  });

  it.each([false, true])(
    "falls back when reload selects a different model without generating (unattributed=%s)",
    async (unattributed) => {
      const session = await openContextSession({ loadedModel: "neon", unattributed });
      try {
        await session.open();
        expect(session.usage()).toMatchObject({
          contextWindowUsedTokens: 10458,
          contextWindowMaxTokens: 1048576,
        });
      } finally {
        await session.close();
      }
    },
  );

  it.each([{ linkedDb: true }, { version: "unknown" }, { model: "neon" }])(
    "retains native ACP usage when local metadata cannot be attributed: %j",
    async (options) => {
      const session = await openContextSession(options);
      try {
        await session.open(options.model);
        expect(session.usage()).toMatchObject({
          contextWindowUsedTokens: 10458,
          contextWindowMaxTokens: 1048576,
        });
      } finally {
        await session.close();
      }
    },
  );
});
