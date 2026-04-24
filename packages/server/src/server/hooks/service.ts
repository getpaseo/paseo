import type { Logger } from "pino";

import { ClaudeCodeHookAdapter } from "./adapters/claude-code.js";
import { HookRegistry } from "./registry.js";
import { HookRuntime, type HookExecutionInput } from "./runtime.js";
import type { HookWithState, HubcodeHook } from "./types.js";

/**
 * Orchestrates the hook registry + per-agent adapters. Consumers should
 * only need `list`, `setEnabled`, and `syncToAgents`. Bootstrap wires one
 * instance and passes it to sessions; the settings RPC talks to it.
 */
export interface HookServiceDeps {
  logger: Logger;
  hubcodeHome: string;
}

export class HookService {
  private readonly logger: Logger;
  private readonly registry: HookRegistry;
  private readonly claudeAdapter: ClaudeCodeHookAdapter;
  private readonly runtime: HookRuntime;
  private syncInFlight = false;
  private syncPending = false;

  constructor(deps: HookServiceDeps) {
    this.logger = deps.logger.child({ module: "hook-service" });
    this.registry = new HookRegistry({
      logger: deps.logger,
      hubcodeHome: deps.hubcodeHome,
    });
    this.claudeAdapter = new ClaudeCodeHookAdapter({ logger: deps.logger });
    this.runtime = new HookRuntime({ logger: deps.logger });
  }

  /**
   * Run every enabled hook matching the incoming tool call (in-process
   * execution, used by Hubcode-GUI / SDK-mode agents). Returns the list of
   * hint strings produced so the caller can surface them to the agent.
   *
   * Fires telemetry per hook that executed (regardless of whether it
   * produced a hint) so the Settings UI shows counts.
   */
  async runPostToolUse(input: HookExecutionInput): Promise<string[]> {
    const enabled = this.registry
      .list()
      .filter((entry) => entry.state.enabled)
      .map((entry) => entry.definition);
    const matching = this.runtime.selectMatching(enabled, {
      agentId: input.agentId ?? "hubcode-gui",
      toolName: input.toolName,
      trigger: "post-tool-use",
    });
    if (matching.length === 0) return [];

    const results = await Promise.all(matching.map((hook) => this.runtime.execute(hook, input)));
    const hints: string[] = [];
    for (const result of results) {
      // Telemetry counts every execution — including ones that produced no
      // hint. The UI distinguishes by showing "fired Nx" separately.
      void this.registry.recordFire(result.hookId);
      if (result.error) {
        this.logger.debug(
          { hookId: result.hookId, error: result.error },
          "hook execution error (ignored)",
        );
        continue;
      }
      if (result.additionalContext) {
        hints.push(result.additionalContext);
        this.logger.info(
          {
            hookId: result.hookId,
            toolName: input.toolName,
            durationMs: result.durationMs,
            hintPreview: result.additionalContext.slice(0, 120),
          },
          "hook produced hint",
        );
      }
    }
    return hints;
  }

  async init(): Promise<void> {
    await this.registry.load();
    // Every change (toggle, upsert, delete) triggers a sync.
    this.registry.onChange(() => {
      void this.syncToAgents();
    });
    // Initial sync so fresh boot reflects the persisted state.
    await this.syncToAgents();
  }

  list(): HookWithState[] {
    return this.registry.list();
  }

  get(id: string): HookWithState | null {
    return this.registry.get(id);
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.registry.setEnabled(id, enabled);
  }

  async upsertUserHook(hook: HubcodeHook): Promise<void> {
    await this.registry.upsertUserHook(hook);
  }

  async deleteUserHook(id: string): Promise<void> {
    await this.registry.deleteUserHook(id);
  }

  async recordFire(id: string): Promise<void> {
    await this.registry.recordFire(id);
  }

  onChange(listener: (event: { id: string }) => void): () => void {
    return this.registry.onChange(listener);
  }

  onTelemetry(listener: (event: { id: string }) => void): () => void {
    return this.registry.onTelemetry(listener);
  }

  /**
   * Write the currently-enabled hooks out to every supported agent's native
   * config. Coalesces overlapping calls via a trailing-edge queue so a
   * burst of toggles only produces one final sync.
   */
  async syncToAgents(): Promise<void> {
    if (this.syncInFlight) {
      this.syncPending = true;
      return;
    }
    this.syncInFlight = true;
    try {
      const enabled = this.registry
        .list()
        .filter((entry) => entry.state.enabled)
        .map((entry) => entry.definition);
      await this.claudeAdapter
        .syncAll(enabled)
        .catch((err) => this.logger.warn({ err }, "Claude Code adapter sync failed"));
      // Other adapters (Codex / OpenCode / Hubcode GUI) plug in here as
      // they land in later PRs. Each is independent and tolerates failure.
    } finally {
      this.syncInFlight = false;
      if (this.syncPending) {
        this.syncPending = false;
        await this.syncToAgents();
      }
    }
  }

  async uninstall(): Promise<void> {
    await this.claudeAdapter
      .removeAll()
      .catch((err) => this.logger.warn({ err }, "Claude Code adapter uninstall failed"));
  }
}
