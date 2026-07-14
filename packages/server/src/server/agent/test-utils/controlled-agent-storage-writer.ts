import { writeJsonFileAtomic } from "../../atomic-file.js";
import type { AgentStorageRecordWriter, StoredAgentRecord } from "../agent-storage.js";

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

export interface HeldAgentStorageWrite {
  started: Promise<void>;
  release(): void;
}

export class ControlledAgentStorageWriter implements AgentStorageRecordWriter {
  private heldWrite: { started: Deferred; released: Deferred } | null = null;
  private nextFailure: Error | null = null;

  holdNextWrite(): HeldAgentStorageWrite {
    if (this.heldWrite) {
      throw new Error("An agent storage write is already held");
    }
    const heldWrite = { started: deferred(), released: deferred() };
    this.heldWrite = heldWrite;
    return {
      started: heldWrite.started.promise,
      release: heldWrite.released.resolve,
    };
  }

  failNextWrite(error: Error): void {
    if (this.nextFailure) {
      throw new Error("An agent storage write failure is already configured");
    }
    this.nextFailure = error;
  }

  async write(filePath: string, record: StoredAgentRecord): Promise<void> {
    const failure = this.nextFailure;
    this.nextFailure = null;
    if (failure) {
      throw failure;
    }

    const heldWrite = this.heldWrite;
    this.heldWrite = null;
    if (heldWrite) {
      heldWrite.started.resolve();
      await heldWrite.released.promise;
    }

    await writeJsonFileAtomic(filePath, record);
  }
}
