import { createInterface } from "node:readline";
import { Socket } from "node:net";

import {
  CommandRuntimeControlSchema,
  CommandRuntimeProcessEventSchema,
  encodeCommandRuntimeMessage,
} from "../dist/index.js";

const control = new Socket({ fd: 3, readable: true, writable: false });
const events = new Socket({ fd: 4, readable: false, writable: true });
const lines = createInterface({ input: control, crlfDelay: Infinity });
const received = [];

process.stdin.on("data", (chunk) => process.stdout.write(chunk));
process.stderr.write(Buffer.from([0x70, 0x74, 0x79, 0x00]));

for await (const line of lines) {
  const message = CommandRuntimeControlSchema.parse(JSON.parse(line));
  received.push(message);
  if (received.length === 1) {
    if (message.type !== "spawn" || message.stdio.kind !== "pty") {
      throw new Error("Expected a PTY spawn envelope");
    }
    writeEvent({ type: "started", protocolVersion: 1 });
  } else if (message.type === "resize") {
    writeEvent({ type: "resized", protocolVersion: 1, id: message.id });
  } else if (message.type !== "signal") {
    throw new Error(`Unexpected PTY control: ${message.type}`);
  }
}

if (received.map((message) => message.type).join(",") !== "spawn,resize,signal") {
  throw new Error("Expected spawn, resize, signal, then fd3 EOF");
}
writeEvent({ type: "eof", protocolVersion: 1 });
writeEvent({ type: "exit", protocolVersion: 1, code: null, signal: "SIGTERM" });
events.end();

function writeEvent(event) {
  events.write(encodeCommandRuntimeMessage(CommandRuntimeProcessEventSchema, event));
}
