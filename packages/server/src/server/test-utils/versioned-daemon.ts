// Browser compatibility tests run a real daemon in a separate Node runtime.
import { createTestPaseoDaemon } from "./paseo-daemon.js";

const daemon = await createTestPaseoDaemon({
  daemonVersion: process.argv[2],
  pluginsEnabled: true,
  mcpEnabled: false,
  corsAllowedOrigins: ["*"],
});
const response = await fetch(`http://127.0.0.1:${daemon.port}/api/status`);
const { serverId } = await response.json();
process.send?.({ port: daemon.port, serverId });
process.once("SIGTERM", async () => {
  await daemon.close();
  process.exit(0);
});
