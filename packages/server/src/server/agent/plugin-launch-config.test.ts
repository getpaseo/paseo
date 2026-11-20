import { expect, test } from "vitest";
import { mergePluginLaunchContributions } from "./plugin-launch-config.js";

test("optional grants cannot target saved or another plugin's MCP binding", () => {
  expect(() =>
    mergePluginLaunchContributions({
      pluginId: "notes",
      servers: {},
      grants: [],
      options: {},
      contribution: {
        mcpServers: { notes: { type: "http", url: "http://127.0.0.1:1/notes" } },
        toolPolicy: { preapproved: [{ kind: "mcp", server: "caller", tool: "write" }] },
      },
    }),
  ).toThrow(
    "Plugin notes cannot preapprove caller.write: server is not contributed by this plugin",
  );
});

test("conflicting plugin options reject without partially collecting their grants", () => {
  const grants: Array<{ kind: "mcp"; server: string; tool: string }> = [];
  const options = { additionalDirectories: ["/first"] };
  expect(() =>
    mergePluginLaunchContributions({
      pluginId: "knowledge",
      servers: {},
      grants,
      options,
      contribution: {
        mcpServers: { knowledge: { type: "http", url: "http://127.0.0.1:1/knowledge" } },
        toolPolicy: { preapproved: [{ kind: "mcp", server: "knowledge", tool: "read" }] },
        providerOptions: { additionalDirectories: ["/different"] },
      },
    }),
  ).toThrow("Plugin knowledge conflicts on launch option additionalDirectories");
  expect(options).toEqual({ additionalDirectories: ["/first"] });
  expect(grants).toEqual([]);
});
