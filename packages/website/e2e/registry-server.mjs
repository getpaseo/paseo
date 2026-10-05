import { createServer } from "node:http";
import registry from "./registry.fixture.json" with { type: "json" };

// Serve the published registry contract so SSR and browser navigation use the same data.
createServer((request, response) => {
  response.setHeader("Content-Type", "application/json");
  if (request.url === "/index.json") {
    response.end(JSON.stringify(registry));
    return;
  }
  const plugin = registry.plugins.find((entry) => request.url === `/plugins/${entry.id}.json`);
  response.statusCode = plugin ? 200 : 404;
  response.end(JSON.stringify(plugin ?? { error: "Plugin not found" }));
}).listen(8188, "127.0.0.1");
