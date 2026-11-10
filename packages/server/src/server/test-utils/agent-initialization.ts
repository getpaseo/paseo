import type { AgentStorage } from "../agent/agent-storage.js";
import type { AgentManager } from "../agent/agent-manager.js";

interface TestSignal {
  promise: Promise<void>;
  resolve: () => void;
}

function createTestSignal(): TestSignal {
  let resolve!: () => void;
  const promise = new Promise<void>((notify) => {
    resolve = notify;
  });
  return { promise, resolve };
}

export function pauseAgentInitialization(manager: AgentManager) {
  const entered = createTestSignal();
  const released = createTestSignal();
  const queued = createTestSignal();
  const create = manager.createAgentFromRecord.bind(manager);
  const resume = manager.resumeAgentFromPersistence.bind(manager);
  manager.createAgentFromRecord = async (...args) => {
    entered.resolve();
    await released.promise;
    const pending = create(...args);
    queued.resolve();
    return pending;
  };
  manager.resumeAgentFromPersistence = async (...args) => {
    entered.resolve();
    await released.promise;
    const pending = resume(...args);
    queued.resolve();
    return pending;
  };
  async function waitForNextLoad(): Promise<void> {
    const waiting = createTestSignal();
    const waitForClose = manager.waitForAgentClose.bind(manager);
    manager.waitForAgentClose = async (agentId) => {
      await waitForClose(agentId);
      waiting.resolve();
    };
    await waiting.promise;
    await Promise.resolve();
  }
  return {
    entered: entered.promise,
    queued: queued.promise,
    release: released.resolve,
    waitForNextLoad,
  };
}

export function pauseArchiveWrite(storage: AgentStorage) {
  const entered = createTestSignal();
  const released = createTestSignal();
  const upsert = storage.upsert.bind(storage);
  storage.upsert = async (record) => {
    if (record.archivedAt) {
      entered.resolve();
      await released.promise;
    }
    return upsert(record);
  };
  return { entered: entered.promise, release: released.resolve };
}
