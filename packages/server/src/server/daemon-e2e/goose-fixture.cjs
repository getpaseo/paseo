// Local ACP peer shaped like `goose acp`.
const readline = require("node:readline");

const inventory = {
  openrouter: { name: "OpenRouter", model: "anthropic/claude-sonnet-4.5" },
  openai: { name: "OpenAI", model: "gpt-4o" },
  anthropic: { name: "Anthropic", model: "sonnet" },
};
let provider = "goose";
let model = inventory.openrouter.model;

const select = (id, currentValue, values) => ({
  id,
  name: id,
  ...(id === "model" ? { category: "model" } : {}),
  type: "select",
  currentValue,
  options: values.map((value) => ({ value, name: value })),
});
const configOptions = () => [
  select("provider", provider, ["goose", ...Object.keys(inventory)]),
  select("model", model, [inventory[provider === "goose" ? "openrouter" : provider].model]),
];
const send = (message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  let result;
  switch (method) {
    case "initialize":
      result = { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] };
      break;
    case "session/new":
    case "session/load":
      result = { sessionId: "goose-fixture", configOptions: configOptions() };
      break;
    case "_goose/unstable/providers/list":
      result = {
        entries: Object.entries(inventory).map(([providerId, entry]) => ({
          providerId,
          providerName: entry.name,
          configured: providerId !== "anthropic",
          models: [{ id: entry.model, name: entry.model }],
        })),
      };
      break;
    case "_goose/unstable/config/read":
      result = {
        value: params.key === "GOOSE_PROVIDER" ? "openrouter" : inventory.openrouter.model,
      };
      break;
    case "session/set_config_option":
      if (params.configId === "provider") {
        provider = params.value;
        model = inventory[provider === "goose" ? "openrouter" : provider].model;
      } else if (params.configId === "model") {
        if (params.value !== inventory[provider === "goose" ? "openrouter" : provider].model) {
          send({ id, error: { code: -32602, message: "Model unavailable for selected provider" } });
          return;
        }
        model = params.value;
      }
      result = { configOptions: configOptions() };
      break;
    case "session/prompt":
      send({
        method: "session/update",
        params: {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `${provider}/${model}` },
          },
        },
      });
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
