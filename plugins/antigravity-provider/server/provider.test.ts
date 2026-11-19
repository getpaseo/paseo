import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { afterEach, expect, it } from "vitest";
import { createAntigravityProvider } from "./provider.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function launchAgent(source: string) {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-antigravity-acp-"));
  directories.push(directory);
  const executable = path.join(directory, "agy.cjs");
  await writeFile(executable, source);
  return {
    directory,
    launch: {
      command: process.execPath,
      args: [executable, "acp", "--disable-telemetry"],
      env: { CAPTURE: path.join(directory, "requests.ndjson") },
    },
  };
}

it("reports a CLI without the acp subcommand as unavailable", async () => {
  const { launch } = await launchAgent(`
    process.stderr.write("Unknown command: acp");
    process.exitCode = 1;
  `);
  const provider = createAntigravityProvider();
  expect(provider.command?.slice(0, 2)).toEqual(["agy", "acp"]);
  expect(await provider.status!({ launch })).toMatchObject({
    available: false,
    diagnostic: expect.stringContaining("1.5.0"),
  });
});

it.each([true, false])(
  "loads a saved stream-JSON session with ACP system prompt support %s",
  async (supportsSystemPrompt) => {
    const { directory, launch } = await launchAgent(`
      const { appendFileSync } = require("node:fs");
      const { createInterface } = require("node:readline");
      const configOptions = [
        { id: "model", name: "Model", category: "model", type: "select", currentValue: "gemini-4-neon",
          options: [{ value: "gemini-4-neon", name: "Gemini 4 Neon" }, { value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" }, { value: "gemini-4-neon-high", name: "Gemini 4 Neon High" }] },
        { id: "thought_level", name: "Thinking", category: "thought_level", type: "select", currentValue: "low",
          options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] },
        { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "accept-edits",
          options: [{ value: "default", name: "Default" }, { value: "accept-edits", name: "Accept edits" }] },
      ];
      const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
      createInterface({ input: process.stdin }).on("line", (line) => {
        appendFileSync(process.env.CAPTURE, line + "\\n");
        const { id, method, params } = JSON.parse(line);
        switch (method) {
          case "initialize":
            send({ id, result: { protocolVersion: 1, agentCapabilities: {
              loadSession: true,
              _meta: { antigravity: { systemPrompt: { append: ${supportsSystemPrompt} } } },
            } } });
            break;
          case "session/load":
            send({ method: "session/update", params: { sessionId: params.sessionId, update: {
              sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Saved reply" },
            } } });
            send({ method: "session/update", params: { sessionId: params.sessionId, update: {
              sessionUpdate: "tool_call", toolCallId: "write", name: "write_file", title: "File notes.txt",
              status: "completed", kind: "edit", rawInput: { Path: "/repo/notes.txt", Content: "hello" },
            } } });
            send({ id, result: { configOptions } });
            break;
          case "session/set_config_option":
            configOptions.find(option => option.id === params.configId).currentValue = params.value;
            send({ id, result: { configOptions } });
            break;
          case "session/close":
            send({ id, result: {} });
            break;
        }
      });
    `);
    const provider = createAntigravityProvider();
    expect(await provider.status!({ launch })).toEqual({ available: true });
    const connection = await provider.connect({
      launch,
      versions: [1],
      capabilities: ["session.configure", "session.persistence"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    try {
      await connection.send({
        type: "session.open",
        requestId: "restore",
        sessionId: "test",
        history: "replay",
        persistence: { version: 1, data: { conversationId: "saved-conversation" } },
        config: {
          cwd: directory,
          model: "gemini-3.8-flash-high",
          mode: "full-access",
          systemPrompt: "A test system instruction",
          env: {},
          mcpServers: {},
          settings: {},
          persist: true,
        },
      });
      await expect
        .poll(
          () =>
            events.find(
              (event) => event.type === "session.ready" || event.type === "request.failed",
            ),
          { timeout: 3_000 },
        )
        .toMatchObject({ type: "session.ready" });
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "session.opened",
          persistence: { version: 1, data: { sessionId: "saved-conversation" } },
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "timeline.item",
          item: expect.objectContaining({ type: "assistant_message", text: "Saved reply" }),
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "session.config",
          config: expect.objectContaining({
            mode: "full-access",
            modes: expect.arrayContaining([
              expect.objectContaining({ id: "full-access", isUnattended: true }),
            ]),
            model: "gemini-3.8-flash",
            thinkingOption: "high",
          }),
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "timeline.item",
          item: expect.objectContaining({
            type: "tool_call",
            detail: { type: "write", filePath: "/repo/notes.txt", content: "hello" },
          }),
        }),
      );
      await connection.send({
        type: "session.configure",
        requestId: "native-model",
        sessionId: "test",
        changes: { model: "gemini-4-neon-high" },
      });
      await expect
        .poll(() =>
          events.find(
            (event) =>
              event.type === "session.config" && event.config.model === "gemini-4-neon-high",
          ),
        )
        .toBeDefined();
      const requests = (await readFile(launch.env.CAPTURE, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const load = requests.find((request) => request.method === "session/load");
      expect(load.params.sessionId).toBe("saved-conversation");
      expect(load.params._meta.antigravity).toEqual(
        supportsSystemPrompt
          ? { systemPrompt: { append: "A test system instruction" } }
          : undefined,
      );
    } finally {
      await connection.close();
    }
  },
);
