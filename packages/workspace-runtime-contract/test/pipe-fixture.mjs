import { readFileSync, writeSync } from "node:fs";

import {
  CommandRuntimeLifecycleRequestSchema,
  CommandRuntimeLifecycleResponseSchema,
  CommandRuntimeProcessEventSchema,
  CommandRuntimeSpawnEnvelopeSchema,
  encodeCommandRuntimeMessage,
} from "../dist/index.js";

const examples = JSON.parse(readFileSync(new URL("../examples/v1.json", import.meta.url), "utf8"));
const mode = process.argv[2] ?? "conversation";

if (mode === "lifecycle") {
  const input = await read(process.stdin);
  CommandRuntimeLifecycleRequestSchema.parse(JSON.parse(input));
  process.stdout.write(
    encodeCommandRuntimeMessage(CommandRuntimeLifecycleResponseSchema, examples.lifecycleResponse),
  );
} else if (mode === "early-exit") {
  process.exitCode = 47;
} else if (mode === "malformed") {
  writeSync(4, "{malformed}\n");
} else if (mode === "wrong-version") {
  writeSync(4, '{"type":"started","protocolVersion":2}\n');
} else {
  const fd3 = readFileSync(3, "utf8");
  const envelope = CommandRuntimeSpawnEnvelopeSchema.parse(JSON.parse(fd3));
  if (envelope.stdio.kind !== "pipes") throw new Error("Expected a pipes spawn envelope");
  const stdin = await read(process.stdin);
  process.stdout.write(Buffer.from([0x00, 0x6f, 0x75, 0x74, 0xff]));
  process.stderr.write(Buffer.from([0x65, 0x72, 0x72, 0x00]));
  await writeEvent(examples.startedEvent, true);
  await writeEvent(examples.eofEvent);
  await writeEvent(examples.exitEvent);
  if (fd3 !== examples.bytes.pipeSpawnControl || stdin !== "raw\u0000stdin\n") {
    process.exitCode = 9;
  }
}

async function writeEvent(event, partial = false) {
  const bytes = encodeCommandRuntimeMessage(CommandRuntimeProcessEventSchema, event);
  if (!partial) {
    writeSync(4, bytes);
    return;
  }
  writeSync(4, bytes.slice(0, 13));
  await new Promise((resolve) => setImmediate(resolve));
  writeSync(4, bytes.slice(13));
}

async function read(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
