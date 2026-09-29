import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { writeFileSync } from "node:fs";

if (process.env.OMP_MCP_PID_FILE) writeFileSync(process.env.OMP_MCP_PID_FILE, String(process.pid));

const server = new McpServer({ name: "omp-echo-fixture", version: "1.0.0" });
server.registerTool(
  "echo_secret",
  { description: "Returns the fixture word", inputSchema: { word: z.string() } },
  async ({ word }, extra) => {
    if (word === "WAIT") {
      if (process.env.OMP_MCP_WAIT_FILE) writeFileSync(process.env.OMP_MCP_WAIT_FILE, "waiting");
      return await new Promise((resolve) => {
        extra.signal.addEventListener(
          "abort",
          () => {
            if (process.env.OMP_MCP_CANCEL_FILE) {
              writeFileSync(process.env.OMP_MCP_CANCEL_FILE, "cancelled");
            }
            resolve({ content: [{ type: "text", text: "cancelled" }] });
          },
          { once: true },
        );
      });
    }
    return word === "FAIL"
      ? { content: [{ type: "text", text: "fixture failure" }], isError: true }
      : { content: [{ type: "text", text: `MANGO:${word}` }] };
  },
);
await server.connect(new StdioServerTransport());
