import { isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { startUnixMcpBridge } from "./mcp-unix-bridge.js";

const { values } = parseArgs({
  options: { socket: { type: "string" }, "agent-id": { type: "string" } },
});
if (!values.socket || !isAbsolute(values.socket) || !values["agent-id"]) {
  throw new Error(
    "Usage: mcp-unix-bridge-cli.mjs --socket <absolute path> --agent-id <Paseo agent ID>",
  );
}

const bridge = await startUnixMcpBridge({
  socketPath: values.socket,
  agentId: values["agent-id"],
  token: process.env.PASEO_AGENT_MCP_TOKEN,
});
process.stdin.once("end", () => void bridge.close());
process.stdin.once("close", () => void bridge.close());
process.once("SIGTERM", () => void bridge.close());
process.once("SIGINT", () => void bridge.close());
process.stdout.once("error", () => void bridge.close());
