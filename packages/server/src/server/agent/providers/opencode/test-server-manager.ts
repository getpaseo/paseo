import type { OpenCodeServerAcquisition, OpenCodeServerManagerLike } from "./server-manager.js";

export interface TestOpenCodeServerAcquisition {
  kind: "current" | "new" | "dedicated" | "existing";
  env?: Record<string, string>;
  url?: string;
  released: boolean;
}

export class TestOpenCodeServerManager implements OpenCodeServerManagerLike {
  readonly acquisitions: TestOpenCodeServerAcquisition[] = [];
  readonly server = { port: 1234, url: "http://127.0.0.1:1234" };
  ensureRunningCount = 0;

  async ensureRunning(): Promise<{ port: number; url: string }> {
    this.ensureRunningCount += 1;
    return this.server;
  }

  async acquireCurrent(): Promise<OpenCodeServerAcquisition> {
    return this.recordAcquisition({ kind: "current" });
  }

  async acquireNew(): Promise<OpenCodeServerAcquisition> {
    return this.recordAcquisition({ kind: "new" });
  }

  async acquireDedicated(env: Record<string, string>): Promise<OpenCodeServerAcquisition> {
    return this.recordAcquisition({ kind: "dedicated", env });
  }

  acquireExisting(url: string): OpenCodeServerAcquisition | null {
    return url === this.server.url ? this.recordAcquisition({ kind: "existing", url }) : null;
  }

  private recordAcquisition(input: {
    kind: TestOpenCodeServerAcquisition["kind"];
    env?: Record<string, string>;
    url?: string;
  }): OpenCodeServerAcquisition {
    const acquisition: TestOpenCodeServerAcquisition = {
      kind: input.kind,
      released: false,
      ...(input.env ? { env: input.env } : {}),
      ...(input.url ? { url: input.url } : {}),
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
