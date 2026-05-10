import type { OpenCodeServerAcquisition, OpenCodeServerManagerLike } from "./server-manager.js";

export interface TestOpenCodeServerAcquisition {
  force: boolean;
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

  async acquire(options: { force: boolean }): Promise<OpenCodeServerAcquisition> {
    const acquisition: TestOpenCodeServerAcquisition = {
      force: options.force,
      released: false,
    };
    this.acquisitions.push(acquisition);
    return {
      server: this.server,
      release: () => {
        acquisition.released = true;
      },
    };
  }
}

export function createTestOpenCodeServerManager(): TestOpenCodeServerManager {
  return new TestOpenCodeServerManager();
}
