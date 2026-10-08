// NO-MODEL FIXTURE. Scripted ACP snapshots, never presented as model output.
const readline = require("node:readline");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
let sequence = 0;
let turn = 0;
const nodes = new Map();
function snapshot(id, extra = {}) {
  const node = {
    version: 1,
    id,
    parentId: null,
    depth: 1,
    status: "running",
    text: "",
    tools: [],
    ...nodes.get(id),
    ...extra,
    sequence: ++sequence,
  };
  nodes.set(id, node);
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "fixture-root",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: `hermes-subagent:${id}`,
        title: "Hermes subagent",
        status: {
          running: "in_progress",
          completed: "completed",
          failed: "failed",
          canceled: "failed",
        }[node.status],
        _meta: { hermes: { subagentProgress: node } },
      },
    },
  });
}
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result = {};
  if (request.method === "initialize")
    result = {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, _meta: { hermes: { subagentProgress: 1 } } },
      authMethods: [],
    };
  else if (request.method === "session/new" || request.method === "session/load") {
    result = { sessionId: "fixture-root", modes: null, configOptions: [] };
    if (request.method === "session/load") {
      snapshot("alpha", {
        status: "completed",
        text: "[NO-MODEL FIXTURE] alpha public output",
        tools: ["terminal"],
      });
      snapshot("nested", {
        parentId: "alpha",
        depth: 2,
        status: "canceled",
        text: "[NO-MODEL FIXTURE] nested public output",
        tools: ["read_file"],
      });
      snapshot("beta", {
        status: "failed",
        text: "[NO-MODEL FIXTURE] beta public output",
        tools: ["terminal"],
      });
    }
  } else if (request.method === "session/prompt") {
    if (++turn === 1) {
      snapshot("alpha", { text: "[NO-MODEL FIXTURE] alpha public output", tools: ["terminal"] });
      snapshot("beta", { text: "[NO-MODEL FIXTURE] beta public output", tools: ["terminal"] });
      snapshot("nested", {
        parentId: "alpha",
        depth: 2,
        text: "[NO-MODEL FIXTURE] nested public output",
        tools: ["read_file"],
      });
    } else {
      snapshot("alpha", { status: "completed" });
      snapshot("beta", { status: "failed" });
      snapshot("nested", { status: "canceled" });
    }
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "fixture-root",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "[NO-MODEL FIXTURE] Root turn finished." },
        },
      },
    });
    result = { stopReason: "end_turn" };
  }
  send({ jsonrpc: "2.0", id: request.id, result });
});
