#!/usr/bin/env node
import readline from "node:readline";

const mode = process.argv[2];
const operation = process.argv[3];

if (operation === "fs-stat") {
  process.stdout.write(
    `${JSON.stringify({
      protocolVersion: 1,
      status: "ready",
      path: "large.bin",
      kind: "binary",
      encoding: "binary",
      mimeType: "application/octet-stream",
      size: Number.MAX_SAFE_INTEGER,
      modifiedAt: "2026-01-01T00:00:00.000Z",
      revision: "fixture-revision",
    })}\n`,
  );
} else if (operation === "fs-read" && mode === "endless-read") {
  const chunk = Buffer.alloc(256 * 1024, 0xa5);
  const write = () => {
    while (process.stdout.write(chunk)) continue;
    process.stdout.once("drain", write);
  };
  write();
} else if (operation === "watch") {
  const safetyExit = setTimeout(() => process.exit(86), 4_000);
  const keepAlive = setInterval(() => undefined, 1_000);
  const finish = () => {
    clearTimeout(safetyExit);
    clearInterval(keepAlive);
  };
  process.once("exit", finish);
  if (mode === "malformed-watch") {
    process.stdout.write("not-json\n");
  } else if (mode !== "no-ready") {
    print({ type: "ready" });
    const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of lines) {
      handleWatchCommand(JSON.parse(line), finish);
    }
  }
} else {
  process.stderr.write(`Unsupported fixture operation: ${mode} ${operation}\n`);
  process.exitCode = 1;
}

function print(value) {
  process.stdout.write(`${JSON.stringify({ protocolVersion: 1, ...value })}\n`);
}

function handleWatchCommand(command, finish) {
  if (command.type === "subscribe" && mode !== "no-subscribed") {
    print({ type: "subscribed", subscriptionId: command.id });
    if (mode === "overflow") print({ type: "overflow", subscriptionId: command.id });
    return;
  }
  if (command.type === "unsubscribe" && mode !== "no-unsubscribed") {
    print({ type: "unsubscribed", subscriptionId: command.id });
    return;
  }
  if (command.type !== "close") return;
  if (mode === "resists-close") process.on("SIGTERM", () => undefined);
  else finish();
}
