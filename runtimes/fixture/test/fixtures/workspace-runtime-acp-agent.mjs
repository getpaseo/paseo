#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

if (process.argv.includes("--version")) {
  process.stdout.write("workspace-runtime-fixture 1.0.0\n");
  process.exit(0);
}

const sessions = new Map();
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    respond(message.id, {
      protocolVersion: message.params?.protocolVersion ?? 1,
      agentCapabilities: { loadSession: false },
    });
    continue;
  }
  if (message.method === "session/new") {
    const modelId = await readFile(path.join(message.params.cwd, "provider-model.txt"), "utf8")
      .then((value) => value.trim())
      .catch(() => "fixture-model");
    const sessionId = `fixture-session-${sessions.size + 1}`;
    sessions.set(sessionId, { cwd: message.params.cwd });
    respond(message.id, {
      sessionId,
      models: {
        availableModels: [{ modelId, name: `Fixture Model ${modelId}` }],
        currentModelId: modelId,
      },
      configOptions: [],
    });
    continue;
  }
  if (message.method === "session/prompt") {
    const session = sessions.get(message.params.sessionId);
    if (!session) throw new Error(`Unknown fixture session: ${message.params.sessionId}`);
    const text = message.params.prompt
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    await writeFile(path.join(session.cwd, "committed.txt"), `${text}\n`);
    await writeFile(path.join(session.cwd, "stdio-agent-output.txt"), `${text}\n`);
    await writeFile(
      path.join(session.cwd, "stdio-agent-env.txt"),
      `${process.env.PASEO_DAEMON_ONLY_PROVIDER_ENV ?? "<absent>"}\n`,
    );
    notify("session/update", {
      sessionId: message.params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `fixture completed: ${text}` },
      },
    });
    respond(message.id, { stopReason: "end_turn" });
    continue;
  }
  if (message.method === "session/cancel") {
    respond(message.id, {});
  }
}

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function notify(method, params) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}
