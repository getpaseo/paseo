import { randomUUID } from "node:crypto";
import {
  MockLoadTestAgentClient,
  MockLoadTestAgentSession,
} from "../agent/providers/mock-load-test-agent.js";
import { createTestPaseoDaemon } from "./paseo-daemon.js";

const firstResponse = Promise.withResolvers<void>();

class RetryQuestionSession extends MockLoadTestAgentSession {
  private attempts = 0;

  override async respondToPermission(
    requestId: string,
    response: Parameters<MockLoadTestAgentSession["respondToPermission"]>[1],
  ) {
    this.attempts += 1;
    process.send?.({ type: "attempt", requestId, response, sessionId: this.id });
    if (this.attempts === 1) {
      await firstResponse.promise;
      throw new Error("Synthetic question response failure");
    }
    return super.respondToPermission(requestId, response);
  }
}

class RetryQuestionClient extends MockLoadTestAgentClient {
  override async createSession(config: Parameters<MockLoadTestAgentClient["createSession"]>[0]) {
    const session = new RetryQuestionSession({ config, sessionId: randomUUID() });
    session.subscribe((event) => {
      if (event.type === "permission_resolved") {
        process.send?.({
          type: "resolved",
          requestId: event.requestId,
          response: event.resolution,
          sessionId: session.id,
          pendingRequestIds: session.getPendingPermissions().map((request) => request.id),
        });
      }
    });
    return session;
  }
}

async function main(): Promise<void> {
  const daemon = await createTestPaseoDaemon({
    agentClients: { mock: new RetryQuestionClient() },
    isDev: true,
    mcpEnabled: false,
    corsAllowedOrigins: [`http://localhost:${process.env.E2E_METRO_PORT}`],
  });
  process.on("message", (message: unknown) => {
    if (message === "release") firstResponse.resolve();
  });
  const shutdown = async () => {
    firstResponse.resolve();
    await daemon.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  process.once("disconnect", () => void shutdown());
  process.send?.({ type: "ready", port: daemon.port, serverId: daemon.daemon.getServerId() });
}

void main().catch((error: unknown) => {
  process.send?.({ type: "error", error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
