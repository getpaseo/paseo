import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin });
const mode = process.env.FAKE_ZCODE_MODE ?? "ok";
const queue = [];
let seq = 0;
/** The sessions this fake created, each with its own id. */
let created = 0;
/** The turn waiting on the host's answer to the fake's permission request. */
let pendingTurn = null;

function push(sessionId, type, payload, extra = {}) {
  seq += 1;
  queue.push({
    eventId: `e${seq}`,
    sessionId,
    turnId: extra.turnId,
    seq,
    timestamp: Date.now(),
    type,
    payload,
  });
}

function pushTurn(sessionId, inputId, content) {
  const turnId = "turn-1";
  push(sessionId, "turn.started", { turnNumber: 1, input: content, inputId }, { turnId });
  push(
    sessionId,
    "message.upserted",
    { messageId: "m1", role: "assistant", content: "hello from zcode" },
    { turnId },
  );
  push(
    sessionId,
    "turn.completed",
    { response: "hello from zcode", tokenCount: 12, toolCallCount: 0, duration: 5 },
    { turnId },
  );
}

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ id, result })}\n`);
}

for await (const line of lines) {
  if (!line.trim()) continue;
  const request = JSON.parse(line);
  const id = request.id;

  // The host's answer to the reverse request the fake sent. It arrives as a
  // frame with the fake's own id, and it is not a request from the host.
  if (id === "perm-1") {
    const turn = pendingTurn;
    pendingTurn = null;
    if (turn) {
      pushTurn(turn.sessionId, turn.inputId, turn.content);
      respond(turn.requestId, {
        sessionId: turn.sessionId,
        accepted: true,
        stateRevision: 1,
      });
    }
    continue;
  }

  if (mode === "exit") {
    process.exit(3);
  }
  if (mode === "stderr") {
    process.stderr.write("ZCode runtime missing\n");
    process.exit(1);
  }

  if (request.method === "session/create") {
    created += 1;
    respond(id, { sessionId: `s${created}` });
    continue;
  }
  if (request.method === "session/read") {
    respond(id, {
      settings: {
        model: {
          current: { providerId: "zai", modelId: "glm-5" },
          available: [
            { ref: { providerId: "zai", modelId: "glm-5" }, label: "GLM 5" },
            { ref: { providerId: "zai", modelId: "glm-4" }, label: "GLM 4" },
          ],
        },
        mode: { current: "plan" },
        thoughtLevel: {
          enabled: true,
          current: "high",
          available: [{ value: "high", label: "High" }],
        },
      },
    });
    continue;
  }
  if (request.method === "session/events") {
    const afterSeq = request.params?.afterSeq ?? 0;
    const sessionId = request.params?.sessionId;
    // The app-server answers with the requested session's own events only.
    respond(id, {
      events: queue.filter((event) => event.seq > afterSeq && event.sessionId === sessionId),
    });
    continue;
  }
  if (request.method === "session/send") {
    const sessionId = request.params.sessionId;
    const turnId = "zcode-turn-1";
    if (mode === "permission") {
      // The fake asks the host for permission and waits for the answer. The
      // loop must not await it here: the answer arrives as a later line, and
      // a loop that awaited would never read it. The call itself is answered
      // right away, so the client is not left waiting on it.
      pendingTurn = {
        sessionId,
        inputId: request.params.inputId,
        content: request.params.content,
        requestId: id,
      };
      process.stdout.write(
        `${JSON.stringify({
          id: "perm-1",
          method: "interaction/requestPermission",
          params: {
            requestId: "perm-1",
            sessionId,
            toolCallId: "t1",
            toolName: "write_file",
            reason: "The agent wants to write a file",
            riskLevel: "medium",
            input: { path: "/tmp/a" },
            options: [
              {
                optionId: "allow",
                kind: "allow-once",
                name: "Allow",
                response: { decision: "allow" },
              },
              {
                optionId: "deny",
                kind: "deny",
                name: "Deny",
                response: { decision: "deny" },
              },
            ],
          },
        })}\n`,
      );
      respond(id, { sessionId, accepted: true, stateRevision: 1 });
      continue;
    }
    push(
      sessionId,
      "turn.started",
      { turnNumber: 1, input: request.params.content, inputId: request.params.inputId },
      { turnId },
    );
    push(
      sessionId,
      "message.upserted",
      { messageId: "m1", role: "assistant", content: "hello from zcode" },
      { turnId },
    );
    push(
      sessionId,
      "turn.completed",
      { response: "hello from zcode", tokenCount: 12, toolCallCount: 0, duration: 5 },
      { turnId },
    );
    respond(id, { sessionId, accepted: true, stateRevision: 1 });
    continue;
  }
  if (request.method === "runtime/capabilities") {
    // The env the child was started with, so a test can assert what the
    // runtime received.
    respond(id, { ok: true, env: process.env });
    if (mode === "report-env") {
      // The env the child was started with, written where the test can read
      // it.
      writeFileSync(process.env.FAKE_ZCODE_ENV_FILE, JSON.stringify(process.env));
    }
    if (mode === "crash") {
      // The child answers, then dies. A crash after the startup is only
      // visible on the exit promise.
      setTimeout(() => process.exit(4), 10);
    }
    continue;
  }
  respond(id, {});
}
