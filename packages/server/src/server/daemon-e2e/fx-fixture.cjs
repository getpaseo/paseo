// Local ACP peer shaped like `fx acp` 0.0.16; no fx install or credentials.
const fs = require("node:fs");
const readline = require("node:readline");
fs.appendFileSync(process.env.FX_TEST_RECORD, "launch\n");
let model = "fixture-small";
const modes = {
  currentModeId: "auto",
  availableModes: [
    { id: "auto", name: "Auto" },
    { id: "ask", name: "Ask" },
    { id: "full-access", name: "Full access" },
  ],
};
const select = (id, name, category, currentValue, values) => ({
  id,
  name,
  category,
  type: "select",
  currentValue,
  options: values.map((value) => ({ value, name: value })),
});
const configOptions = () => [
  select("provider", "Provider", "model", "gateway", ["gateway", "codex", "grok"]),
  select("model", "Model", "model", model, ["fixture-small", "fixture-large"]),
  select("mode", "Session Mode", "mode", modes.currentModeId, ["auto", "ask", "full-access"]),
  select("fast", "Fast Mode", "model", "false", ["false", "true"]),
];
const send = (message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result = {};
  if (request.method === "initialize")
    result = { protocolVersion: 1, agentCapabilities: {}, authMethods: [] };
  if (request.method === "session/new")
    result = { sessionId: "fx-fixture", modes, configOptions: configOptions() };
  if (request.method === "session/set_config_option") {
    if (request.params.configId === "model") model = request.params.value;
    result = { configOptions: configOptions() };
  }
  if (request.method === "session/prompt") result = { stopReason: "end_turn" };
  send({ id: request.id, result });
});
