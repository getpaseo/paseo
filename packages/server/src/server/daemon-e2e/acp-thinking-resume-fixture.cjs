// ACP peer that accepts a thinking level on creation but rejects it after load.
const readline = require("node:readline");

const sessionId = "thinking-resume-session";
let model = "startup-model";
let effort = "low";
let mode = "agent";
let loaded = false;

const send = (message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");

function select(id, category, currentValue, values) {
  return {
    id,
    name: id,
    category,
    type: "select",
    currentValue,
    options: values.map((value) => ({ value, name: value })),
  };
}

function configOptions() {
  return [
    select("mode", "mode", mode, ["agent", "plan"]),
    select("model", "model", model, ["startup-model", "second-model"]),
    select(
      "effort",
      "thought_level",
      effort,
      loaded && model === "second-model"
        ? ["minimal", "low", "medium", "high", "xhigh"]
        : ["low", "high", "max"],
    ),
  ];
}

function assistantMessage(text) {
  send({
    method: "session/update",
    params: {
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    },
  });
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  let result;
  switch (method) {
    case "initialize":
      result = {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } },
      };
      break;
    case "session/new":
      result = { sessionId, configOptions: configOptions() };
      break;
    case "session/load":
      loaded = true;
      model = process.env.ACP_TEST_LOAD_MODEL;
      effort = model === "second-model" && !process.env.ACP_TEST_SAVED_MODE ? "high" : "low";
      assistantMessage("Response from the saved session");
      result = { configOptions: configOptions() };
      break;
    case "session/set_config_option":
      if (params.configId === "model") {
        model = params.value;
        if (loaded && model === "second-model") effort = "high";
      } else if (params.configId === "mode") {
        mode = params.value;
        if (loaded && mode === process.env.ACP_TEST_SAVED_MODE) effort = "high";
      } else if (loaded && params.value === "max") {
        send({
          id,
          error: {
            code: -32602,
            message: "Invalid params",
            data: "This model does not support that thinking level",
          },
        });
        return;
      } else {
        effort = params.value;
      }
      result = { configOptions: configOptions() };
      break;
    case "session/prompt":
      assistantMessage("Response from the saved session");
      result = { stopReason: "end_turn" };
      break;
    case "session/close":
      result = {};
      break;
    default:
      send({ id, error: { code: -32601, message: "Method not found" } });
      return;
  }
  send({ id, result });
});
