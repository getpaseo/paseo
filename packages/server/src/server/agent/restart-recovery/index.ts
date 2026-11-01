import type { AgentStorage, StoredAgentRecord } from "../agent-storage.js";
interface Dependencies {
  storage: AgentStorage;
  settings(): { enabled: boolean; prompt: string };
  eligible(record: StoredAgentRecord): Promise<boolean>;
  dispatch(agentId: string, prompt: string): Promise<unknown>;
  report(agentId: string, error: unknown): void;
}
export function createRestartRecovery(deps: Dependencies) {
  // Candidates are chosen at startup; each settles once its resume was sent or abandoned.
  const resuming = new Map<string, { promise: Promise<void>; resolve(): void }>();
  const eligible = async (record: StoredAgentRecord) =>
    !record.archivedAt && !record.internal && !record.owner && (await deps.eligible(record));
  async function resume(agentId: string) {
    const record = await deps.storage.get(agentId);
    if (!record?.resumeOnStartup) return;
    await deps.storage.upsert({ ...record, resumeOnStartup: false });
    if (!deps.settings().enabled || !(await eligible(record))) return;
    await deps.dispatch(agentId, deps.settings().prompt);
  }
  return {
    /** Choose candidates before anything else reads or repairs persisted running status. */
    async prepareStartup() {
      for (const record of await deps.storage.list()) {
        const pending =
          deps.settings().enabled &&
          (record.resumeOnStartup === true || record.lastStatus === "running") &&
          (await eligible(record));
        await deps.storage.upsert({
          ...record,
          resumeOnStartup: pending,
          lastStatus:
            record.lastStatus === "running" || record.lastStatus === "initializing"
              ? "closed"
              : record.lastStatus,
        });
        if (pending) {
          let resolve!: () => void;
          const promise = new Promise<void>((settle) => {
            resolve = settle;
          });
          resuming.set(record.id, { promise, resolve });
        }
      }
    },
    async captureRunningAgents() {
      await deps.storage.flush();
      for (const record of await deps.storage.list()) {
        if (record.lastStatus === "running" && (await eligible(record)))
          await deps.storage.upsert({ ...record, resumeOnStartup: deps.settings().enabled });
      }
    },
    /** Resume every candidate in the background; a slow provider holds back only its agent. */
    resumePending() {
      for (const [agentId, settled] of resuming) {
        void resume(agentId)
          .catch((error) => deps.report(agentId, error))
          .finally(() => {
            resuming.delete(agentId);
            settled.resolve();
          });
      }
    },
    /** Wait until this agent's resume was sent or abandoned. Others return at once. */
    async waitForResume(agentId: string, signal: AbortSignal) {
      const settled = resuming.get(agentId);
      if (!settled) return;
      let abort!: () => void;
      const aborted = new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason);
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
      try {
        await Promise.race([settled.promise, aborted]);
      } finally {
        signal.removeEventListener("abort", abort);
      }
    },
  };
}
