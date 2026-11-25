import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createTestPaseoDaemon } from "./paseo-daemon.js";

const [, , origin] = process.argv;
if (!origin) throw new Error("Expected the app origin");

const daemon = await createTestPaseoDaemon({
  corsAllowedOrigins: [origin],
  getTailscaleNetwork: () => ({ addresses: ["127.0.0.2"], otherAddresses: new Set() }),
});
try {
  await writeFile(
    path.join(daemon.paseoHome, "config.json"),
    JSON.stringify({ version: 1, daemon: { listen: `127.0.0.1:${daemon.port}` } }),
  );
  process.once("SIGTERM", async () => {
    await daemon.close();
    process.exit(0);
  });
  process.send?.({ port: daemon.port, serverId: daemon.daemon.getServerId() });
} catch (error) {
  await daemon.close();
  throw error;
}
