import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin });
const mode = process.env.FAKE_ZCODE_MODE ?? "ok";

for await (const line of lines) {
  if (!line.trim()) continue;
  const request = JSON.parse(line);
  if (mode === "exit") {
    process.exit(3);
  }
  if (mode === "stderr") {
    process.stderr.write("ZCode runtime missing\n");
    process.exit(1);
  }
  const id = request.id;
  if (request.method === "session/create") {
    process.stdout.write(`${JSON.stringify({ id, result: { sessionId: "s1" } })}\n`);
    continue;
  }
  if (request.method === "session/events") {
    process.stdout.write(`${JSON.stringify({ id, result: { events: [] } })}\n`);
    continue;
  }
  if (request.method === "session/send") {
    process.stdout.write(
      `${JSON.stringify({ id, result: { sessionId: request.params.sessionId, accepted: true, stateRevision: 1 } })}\n`,
    );
    continue;
  }
  process.stdout.write(`${JSON.stringify({ id, result: {} })}\n`);
}
