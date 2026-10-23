import { DaemonClient } from "../../../packages/server/src/server/test-utils/daemon-client.ts";
const clients = new Map();
async function execute(command) {
  const { index } = command;
  if (command.op === "connect") {
    const c = new DaemonClient({
      url: command.url,
      appVersion: "0.12.0",
      clientId: "isolated-memory-" + index,
    });
    await c.connect();
    await c.fetchAgents({ subscribe: {} });
    for (const id of command.agents) c.subscribeAgentTimeline(id, () => {});
    clients.set(index, c);
    return { connected: clients.size };
  }
  if (command.op === "close") {
    const c = clients.get(index);
    await c?.close();
    clients.delete(index);
    return { connected: clients.size };
  }
  if (command.op === "fetch") {
    const result = await clients.get(index).fetchAgentTimeline(command.agentId, { limit: 200 });
    return { rows: result.rows?.length ?? null };
  }
  if (command.op === "shutdown") {
    for (const c of clients.values()) await c.close();
    clients.clear();
    return { connected: 0 };
  }
  throw new Error("Unknown client operation");
}
process.on("message", async (message) => {
  try {
    const result = await execute(message);
    process.send?.({ requestId: message.requestId, result });
  } catch (error) {
    process.send?.({ requestId: message.requestId, error: String(error.stack ?? error) });
  }
});
process.on("disconnect", async () => {
  for (const c of clients.values()) await c.close().catch(() => {});
  process.exit(0);
});
