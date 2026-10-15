// Local ACP peer for the bundled Hoplite adapter; no Hoplite service or credentials.
const fs = require("node:fs");
const readline = require("node:readline");
fs.appendFileSync(process.env.HOPLITE_TEST_RECORD, "launch\n");
const configOptions = [
  {
    id: "model",
    category: "model",
    type: "select",
    name: "Model",
    currentValue: "fixture-model",
    options: [{ value: "fixture-model", name: "Fixture model" }],
  },
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
    result = {
      sessionId: "hoplite-fixture",
      configOptions,
    };
  if (request.method === "session/set_config_option") result = { configOptions };
  if (request.method === "session/prompt") {
    send({
      method: "_hoplite/run_phase",
      params: { runId: "fixture-run", phase: "provisioning", label: "Preparing fixture workspace" },
    });
    result = { stopReason: "end_turn" };
  }
  send({ id: request.id, result });
});
