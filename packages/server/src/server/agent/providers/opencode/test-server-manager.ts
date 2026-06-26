import type {
  OpenCodeServerAcquisition,
  OpenCodeServerManagerLike,
  OpenCodeServerScope,
} from "./server-manager.js";

export interface TestOpenCodeServerAcquisition {
  kind: "current" | "new" | "dedicated";
  env?: Record<string, string>;
  cwd?: string;
  agentId?: string;
  sessionId?: string;
  released: boolean;
}

export class TestOpenCodeServerManager implements OpenCodeServerManagerLike {
  readonly acquisitions: TestOpenCodeServerAcquisition[] = [];
  readonly server = { port: 1234, url: "http://127.0.0.1:1234" };
  ensureRunningCount = 0;

  async ensureRunning(_scope?: OpenCodeServerScope): Promise<{ port: number; url: string }> {
    this.ensureRunningCount += 1;
    return this.server;
  }

  async acquireCurrent(scope?: OpenCodeServerScope): Promise<OpenCodeServerAcquisition> {
    return this.recordAcquisition({ kind: "current", scope });
  }

  async acquireNew(scope?: OpenCodeServerScope): Promise<OpenCodeServerAcquisition> {
    return this.recordAcquisition({ kind: "new", scope });
  }

  async acquireDedicated(
    env: Record<string, string>,
    scope?: OpenCodeServerScope,
  ): Promise<OpenCodeServerAcquisition> {
    return this.recordAcquisition({ kind: "dedicated", env, scope });
  }

  private recordAcquisition(input: {
    kind: TestOpenCodeServerAcquisition["kind"];
    env?: Record<string, string>;
    scope?: OpenCodeServerScope;
  }): OpenCodeServerAcquisition {
    const acquisition: TestOpenCodeServerAcquisition = {
      kind: input.kind,
      released: false,
      ...(input.env ? { env: input.env } : {}),
      ...(input.scope?.cwd ? { cwd: input.scope.cwd } : {}),
      ...(input.scope?.agentId ? { agentId: input.scope.agentId } : {}),
      ...(input.scope?.sessionId ? { sessionId: input.scope.sessionId } : {}),
    };
    this.acquisitions.push(acquisition);
    return {
      server: this.server,
      release: () => {
        acquisition.released = true;
      },
    };
  }

  async shutdown(): Promise<void> {}
}

export function createTestOpenCodeServerManager(): TestOpenCodeServerManager {
  return new TestOpenCodeServerManager();
}
