import type { Logger } from "pino";

import { CommandAdapter } from "./adapters.js";
import { CommandRegistry } from "./registry.js";
import type { CommandWithState, HubcodeCommand } from "./types.js";

/**
 * Orchestrates the command registry + adapter. Settings RPC talks to this
 * surface; bootstrap wires a single instance and passes it to sessions.
 */
export interface CommandServiceDeps {
  logger: Logger;
  hubcodeHome: string;
  /** Returns CLI provider ids currently activated on this host. */
  resolveActiveAgents: () => Promise<Set<string>>;
}

export class CommandService {
  private readonly logger: Logger;
  private readonly registry: CommandRegistry;
  private readonly adapter: CommandAdapter;
  private syncInFlight = false;
  private syncPending = false;

  constructor(deps: CommandServiceDeps) {
    this.logger = deps.logger.child({ module: "command-service" });
    this.registry = new CommandRegistry({
      logger: deps.logger,
      hubcodeHome: deps.hubcodeHome,
    });
    this.adapter = new CommandAdapter({
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

  async list(): Promise<CommandWithState[]> {
    const entries = this.registry.list();
    // Attach install status per agent (surfaces disabled CLIs in the UI).
    const withStatus = await Promise.all(
      entries.map(async (entry) => {
        try {
          const installStatus = await this.adapter.statusFor(entry.definition);
          return { ...entry, state: { ...entry.state, installStatus } };
        } catch (err) {
          this.logger.debug({ err, id: entry.definition.id }, "status probe failed");
          return entry;
        }
      }),
    );
    return withStatus;
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.registry.setEnabled(id, enabled);
  }

  async upsertUserCommand(cmd: HubcodeCommand): Promise<void> {
    await this.registry.upsertUserCommand(cmd);
  }

  async deleteUserCommand(id: string): Promise<void> {
    await this.registry.deleteUserCommand(id);
  }

  onChange(listener: (event: { id: string }) => void): () => void {
    return this.registry.onChange(listener);
  }

  /** Called when CLI providers are activated/deactivated on the host. */
  async refreshForAgentChange(): Promise<void> {
    await this.syncToAgents();
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
        .catch((err) => this.logger.warn({ err }, "command adapter sync failed"));
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
      .catch((err) => this.logger.warn({ err }, "command adapter uninstall failed"));
  }
}
