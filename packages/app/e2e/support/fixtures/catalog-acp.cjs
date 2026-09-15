const readline = require("node:readline");
const model = { modelId: "gemini-3.5-flash", name: "Gemini 3.5 Flash" };
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result = {};
  if (request.method === "initialize")
    result = { protocolVersion: 1, agentCapabilities: {}, authMethods: [] };
  if (request.method === "session/new")
    result = {
      sessionId: "catalog-diagnostic",
      models: {
        currentModelId: model.modelId,
        availableModels: Array.from({ length: Number(process.argv[2]) }, () => model),
      },
    };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
});
