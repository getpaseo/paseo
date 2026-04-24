import type { Logger } from "pino";

import { RuleAdapter } from "./adapters.js";
import { RuleRegistry } from "./registry.js";
import type { HubcodeRule, RuleWithState } from "./types.js";

export interface RuleServiceDeps {
  logger: Logger;
  hubcodeHome: string;
  resolveActiveAgents: () => Promise<Set<string>>;
}

export class RuleService {
  private readonly logger: Logger;
  private readonly registry: RuleRegistry;
  private readonly adapter: RuleAdapter;
  private syncInFlight = false;
  private syncPending = false;

  constructor(deps: RuleServiceDeps) {
    this.logger = deps.logger.child({ module: "rule-service" });
    this.registry = new RuleRegistry({ logger: deps.logger, hubcodeHome: deps.hubcodeHome });
    this.adapter = new RuleAdapter({
      logger: deps.logger,
      resolveActiveAgents: deps.resolveActiveAgents,
    });
  }

  async init(): Promise<void> {
    await this.registry.load();
    this.registry.onChange(() => {
      void this.syncToAgents();
    });
    await this.syncToAgents();
  }

  async list(): Promise<RuleWithState[]> {
    const entries = this.registry.list();
    const withStatus = await Promise.all(
      entries.map(async (entry) => {
        try {
          const installStatus = await this.adapter.statusFor(entry.definition);
          return { ...entry, state: { ...entry.state, installStatus } };
        } catch (err) {
          this.logger.debug({ err, id: entry.definition.id }, "rule status probe failed");
          return entry;
        }
      }),
    );
    return withStatus;
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.registry.setEnabled(id, enabled);
  }

  async upsertUserRule(rule: HubcodeRule): Promise<void> {
    await this.registry.upsertUserRule(rule);
  }

  async deleteUserRule(id: string): Promise<void> {
    await this.registry.deleteUserRule(id);
  }

  onChange(listener: (event: { id: string }) => void): () => void {
    return this.registry.onChange(listener);
  }

  async syncToAgents(): Promise<void> {
    if (this.syncInFlight) {
      this.syncPending = true;
      return;
    }
    this.syncInFlight = true;
    try {
      const enabled = this.registry
        .list()
        .filter((e) => e.state.enabled)
        .map((e) => e.definition);
      await this.adapter
        .syncAll(enabled)
        .catch((err) => this.logger.warn({ err }, "rule adapter sync failed"));
    } finally {
      this.syncInFlight = false;
      if (this.syncPending) {
        this.syncPending = false;
        await this.syncToAgents();
      }
    }
  }

  async uninstall(): Promise<void> {
    await this.adapter
      .removeAll()
      .catch((err) => this.logger.warn({ err }, "rule adapter uninstall failed"));
  }
}
