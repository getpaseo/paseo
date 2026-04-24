import { createNodeRelayServer } from "./node-adapter.js";

const host = process.env.HOST || "0.0.0.0";
const port = Number(process.env.PORT || "8787");

const relay = await createNodeRelayServer({ host, port });

console.log(`[relay] listening on ${relay.host}:${relay.port}`);

const shutdown = async (): Promise<void> => {
  await relay.close();
  process.exit(0);
};

process.on("SIGINT", () => {
  void shutdown();
});

process.on("SIGTERM", () => {
  void shutdown();
});
