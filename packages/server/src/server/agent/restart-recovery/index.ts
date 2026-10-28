import type { AgentStorage, StoredAgentRecord } from "../agent-storage.js";
interface Dependencies {
  storage: AgentStorage;
  settings(): { enabled: boolean; prompt: string };
  eligible(record: StoredAgentRecord): Promise<boolean>;
  dispatch(agentId: string, prompt: string): Promise<unknown>;
  report(agentId: string, error: unknown): void;
}
export function createRestartRecovery(deps: Dependencies) {
  const eligible = async (record: StoredAgentRecord) =>
    !record.archivedAt && !record.internal && !record.owner && (await deps.eligible(record));
  return {
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
      }
    },
    async captureRunningAgents() {
      await deps.storage.flush();
      for (const record of await deps.storage.list()) {
        if (record.lastStatus === "running" && (await eligible(record)))
          await deps.storage.upsert({ ...record, resumeOnStartup: deps.settings().enabled });
      }
    },
    async resumePending() {
      for (const candidate of await deps.storage.list()) {
        if (!candidate.resumeOnStartup) continue;
        const record = await deps.storage.get(candidate.id);
        if (!record) continue;
        await deps.storage.upsert({ ...record, resumeOnStartup: false });
        if (!deps.settings().enabled || !(await eligible(record))) continue;
        try {
          await deps.dispatch(record.id, deps.settings().prompt);
        } catch (error) {
          deps.report(record.id, error);
        }
      }
    },
  };
}
