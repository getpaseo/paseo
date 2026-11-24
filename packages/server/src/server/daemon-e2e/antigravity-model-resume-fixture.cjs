// ACP peer that stops offering a model between daemon runs.
const readline = require("node:readline");

const sessionId = "antigravity-model-resume";
const models = process.env.AGY_TEST_RETIRED ? ["current-model", "other-model"] : ["old-model"];
let model = models[0];
const modes = {
  currentModeId: "default",
  availableModes: [{ id: "default", name: "Default" }],
};

function configOptions() {
  return [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: model,
      options: models.map((value) => ({ name: value, value })),
    },
  ];
}

function send(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
}

function notify(update) {
  send({ method: "session/update", params: { sessionId, update } });
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  switch (method) {
    case "initialize":
      send({
        id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } },
        },
      });
      break;
    case "session/load":
      notify({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "A saved Antigravity reply" },
      });
    // Fall through to send the same selectors as session/new.
    case "session/new":
      notify({ sessionUpdate: "available_commands_update", availableCommands: [] });
      send({ id, result: { sessionId, modes, configOptions: configOptions() } });
      break;
    case "session/set_config_option":
      if (params.configId !== "model" || !models.includes(params.value)) {
        send({
          id,
          error: { code: -32602, message: `Unknown model ID: ${params.value}` },
        });
        break;
      }
      model = params.value;
      send({ id, result: { configOptions: configOptions() } });
      break;
    case "session/close":
      send({ id, result: {} });
      break;
    default:
      if (id !== undefined) {
        send({ id, error: { code: -32601, message: "Method not found" } });
      }
  }
});
