import readline from "node:readline";
import { randomUUID } from "node:crypto";

const fast = { id: "priority", name: "Fast", description: "Faster processing, increased usage" };
const ultra = {
  id: "ultrafast",
  name: "Ultrafast",
  description: "Lowest latency, increased usage",
};
const models = [
  { id: "gpt-6.1-sol", displayName: "GPT-6.1 Sol", isDefault: true, serviceTiers: [fast, ultra] },
  { id: "gpt-6-sol", displayName: "GPT-6 Sol", serviceTiers: [fast] },
].map((model) =>
  Object.assign(model, {
    model: model.id,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Medium" }],
  }),
);

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}
function respond(method, params) {
  switch (method) {
    case "initialize":
      return {};
    case "model/list":
      return { data: models };
    case "config/read":
      return { config: { model: models[0].id, model_reasoning_effort: "medium" } };
    case "collaborationMode/list":
      return { data: [] };
    case "skills/list":
      return { data: [] };
    case "thread/list":
    case "thread/loaded/list":
      return { data: [] };
    case "thread/start":
      return { thread: { id: randomUUID() }, model: params.model };
    case "thread/resume":
      return { thread: { id: params.threadId } };
    case "thread/read":
      return { thread: { id: params.threadId, turns: [] } };
    case "turn/start": {
      const turnId = randomUUID();
      setTimeout(() => {
        send({
          method: "turn/started",
          params: { threadId: params.threadId, turn: { id: turnId } },
        });
        send({
          method: "item/completed",
          params: {
            threadId: params.threadId,
            turnId,
            item: {
              id: randomUUID(),
              type: "agentMessage",
              text: "Ready to work on this project.",
            },
          },
        });
        send({
          method: "turn/completed",
          params: { threadId: params.threadId, turn: { id: turnId, status: "completed" } },
        });
      }, 50);
      return { turn: { id: turnId } };
    }
    default:
      throw new Error(`Unsupported Codex fixture request: ${method}`);
  }
}

if (process.argv.includes("--version")) {
  console.log("codex-cli 0.159.0");
} else {
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    const request = JSON.parse(line);
    if (request.id === undefined) return;
    try {
      send({ id: request.id, result: respond(request.method, request.params ?? {}) });
    } catch (error) {
      send({ id: request.id, error: { code: -32601, message: error.message } });
    }
  });
}
