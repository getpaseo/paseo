import {
  AUTO_RESUME_USAGE_LIMIT_LABEL,
  usageLimitResumeAt,
} from "@getpaseo/protocol/agent-usage-limit";
import type { Logger } from "pino";
import type { AgentManager } from "./agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "./agent-storage.js";

interface UsageLimitResumeOptions {
  agentStorage: Pick<AgentStorage, "list">;
  agentManager: Pick<AgentManager, "resumeAfterUsageLimit">;
  canResumeWorkspace: (record: StoredAgentRecord) => Promise<boolean>;
  logger: Logger;
}

export class UsageLimitResumeService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private pending: Promise<void> | null = null;

  constructor(private readonly options: UsageLimitResumeOptions) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((error) => {
        this.options.logger.error({ err: error }, "Usage limit resume scan failed");
      });
    }, 5_000);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.pending;
  }

  tick(): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = this.resumeDueAgents().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async resumeDueAgents(): Promise<void> {
    for (const record of await this.options.agentStorage.list()) {
      if (record.archivedAt || record.internal || !record.usageLimit) continue;
      if (record.labels[AUTO_RESUME_USAGE_LIMIT_LABEL] !== "true") continue;
      const resumeAt = usageLimitResumeAt(record.usageLimit);
      if (resumeAt === null || resumeAt > Date.now()) continue;
      try {
        if (!(await this.options.canResumeWorkspace(record))) continue;
        await this.options.agentManager.resumeAfterUsageLimit(record.id, record.usageLimit);
      } catch (error) {
        this.options.logger.warn({ err: error, agentId: record.id }, "Usage limit resume failed");
      }
    }
  }
}
