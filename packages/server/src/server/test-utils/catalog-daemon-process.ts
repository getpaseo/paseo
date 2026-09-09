import { readFile, appendFile, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";
import { ProviderOverridesSchema } from "../agent/provider-launch-config.js";
import { createTestPaseoDaemon } from "./paseo-daemon.js";
import { buildProviderRegistry, createClientsFromRegistry } from "../agent/provider-registry.js";
import type { AgentClient } from "../agent/agent-sdk-types.js";

// Real catalog and daemon, with a fail-closed session port for selector-only journeys.
async function main() {
  const logger = pino({ level: "warn" });
  const guardLog = process.env.E2E_CATALOG_GUARD_LOG;
  if (!guardLog) throw new Error("Catalog guard log is required");
  const providerOverrides = ProviderOverridesSchema.parse(
    JSON.parse(process.env.E2E_CATALOG_PROVIDERS ?? "{}"),
  );
  const registry = buildProviderRegistry(logger, { isDev: true, providerOverrides });
  const clients = createClientsFromRegistry(registry, logger);
  const agentClients: Record<string, AgentClient> = {};
  for (const [id, client] of Object.entries(clients)) {
    const denySession = async (): Promise<never> => {
      await appendFile(guardLog, `${id} session creation rejected\n`);
      throw new Error(
        "Selector tests must not create provider sessions, including naming sessions",
      );
    };
    agentClients[id] = {
      provider: client.provider,
      capabilities: client.capabilities,
      createSession: denySession,
      resumeSession: denySession,
      fetchCatalog: (options, context) => registry[id].fetchCatalog(options, client, context),
      isAvailable: client.isAvailable.bind(client),
      resolveCreateConfig: client.resolveCreateConfig?.bind(client),
      resolveDefaultModeId: client.resolveDefaultModeId?.bind(client),
      isCreateConfigUnattended: client.isCreateConfigUnattended?.bind(client),
      listFeatures: client.listFeatures?.bind(client),
      listCommands: client.listCommands?.bind(client),
      shutdown: client.shutdown?.bind(client),
    };
  }
  const paseoHomeRoot = await mkdtemp(path.join(tmpdir(), "paseo-catalog-daemon-"));
  const paseoHome = path.join(paseoHomeRoot, ".paseo");
  await mkdir(paseoHome);
  await writeFile(
    path.join(paseoHome, "config.json"),
    JSON.stringify({ version: 1, agents: { providers: providerOverrides } }),
  );
  const daemon = await createTestPaseoDaemon({
    paseoHomeRoot,
    logger,
    isDev: true,
    agentClients,
    providerOverrides,
    mcpEnabled: false,
    corsAllowedOrigins: [`http://localhost:${process.env.E2E_METRO_PORT}`],
  });
  const serverId = (await readFile(path.join(daemon.paseoHome, "server-id"), "utf8")).trim();
  process.send?.({ port: daemon.port, serverId, paseoHome: daemon.paseoHome });
  process.once("message", async () => {
    await daemon.close();
    process.exit(0);
  });
}
void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
