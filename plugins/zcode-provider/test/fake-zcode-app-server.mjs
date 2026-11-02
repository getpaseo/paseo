import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin });
const mode = process.env.FAKE_ZCODE_MODE ?? "ok";
const queue = [];
let seq = 0;
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
    respond(id, { sessionId: "s1" });
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
    respond(id, { events: queue.filter((event) => event.seq > afterSeq) });
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
    respond(id, { ok: true });
    continue;
  }
  respond(id, {});
}
