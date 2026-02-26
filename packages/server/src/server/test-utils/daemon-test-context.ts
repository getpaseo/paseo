import { createTestJunctionDaemon, type TestJunctionDaemon } from "./junction-daemon.js";
import { DaemonClient } from "./daemon-client.js";
import { createTestAgentClients } from "./fake-agent-client.js";

export interface DaemonTestContext {
  daemon: TestJunctionDaemon;
  client: DaemonClient;
  cleanup: () => Promise<void>;
}

/**
 * Create a test context with an isolated daemon and connected client.
 *
 * Usage:
 * ```typescript
 * let ctx: DaemonTestContext;
 *
 * beforeEach(async () => {
 *   ctx = await createDaemonTestContext();
 * });
 *
 * afterEach(async () => {
 *   await ctx.cleanup();
 * });
 *
 * test("creates agent", async () => {
 *   const agent = await ctx.client.createAgent({
 *     provider: "codex",
 *     cwd: "/tmp",
 *   });
 *   expect(agent.id).toBeTruthy();
 * });
 * ```
 */
export async function createDaemonTestContext(
  options?: Parameters<typeof createTestJunctionDaemon>[0]
): Promise<DaemonTestContext> {
  const daemon = await createTestJunctionDaemon({
    agentClients: createTestAgentClients(),
    ...options,
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
  });
  await client.connect();
  await client.fetchAgents({ subscribe: { subscriptionId: "test" } });

  return {
    daemon,
    client,
    cleanup: async () => {
      await client.close();
      await daemon.close();
    },
  };
}
