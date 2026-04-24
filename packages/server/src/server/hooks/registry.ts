import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";

import { buildBuiltinHooks, BUILTIN_HOOK_IDS } from "./builtins.js";
import { HubcodeHookSchema, type HubcodeHook, type HookWithState } from "./types.js";

/**
 * Storage layout (under `<HUBCODE_HOME>/hooks/`):
 *
 *   definitions/<id>.json    — one user-authored hook per file (built-ins
 *                              live in memory; never written here)
 *   state.json               — { [hookId]: { enabled, lastFiredAt, firedCount } }
 *
 * Rationale for splitting definition and state:
 *   - User "disabling" a built-in must not require writing a fake definition.
 *   - State mutates frequently (telemetry ticks); definitions are almost
 *     always append-only. Separate files keep fsync contention low.
 */

export interface HookRegistryDeps {
  logger: Logger;
  hubcodeHome: string;
}

interface PersistedState {
  [hookId: string]: {
    enabled?: boolean;
    lastFiredAt?: string;
    firedCount?: number;
  };
}

export class HookRegistry {
  private readonly logger: Logger;
  private readonly definitionsDir: string;
  private readonly stateFile: string;
  private readonly events = new EventEmitter();
  private userHooks: HubcodeHook[] = [];
  private state: PersistedState = {};
  private loaded = false;

  constructor(deps: HookRegistryDeps) {
    this.logger = deps.logger.child({ module: "hook-registry" });
    const root = path.join(deps.hubcodeHome, "hooks");
    this.definitionsDir = path.join(root, "definitions");
    this.stateFile = path.join(root, "state.json");
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    await fs.mkdir(this.definitionsDir, { recursive: true });
    await this.loadUserHooks();
    await this.loadState();
    this.ensureBuiltinDefaults();
    this.loaded = true;
  }

  private async loadUserHooks(): Promise<void> {
    try {
      const entries = await fs.readdir(this.definitionsDir);
      const loaded: HubcodeHook[] = [];
      for (const entry of entries) {
        if (!entry.endsWith(".json")) continue;
        const full = path.join(this.definitionsDir, entry);
        try {
          const raw = await fs.readFile(full, "utf8");
          const parsed = HubcodeHookSchema.parse(JSON.parse(raw));
          if (parsed.author === "builtin") {
            // User attempted to override a built-in by writing a file under
            // the same id. Ignore — built-ins live in memory, never on disk.
            this.logger.warn(
              { id: parsed.id, path: full },
              "Skipping user hook with builtin author",
            );
            continue;
          }
          loaded.push(parsed);
        } catch (err) {
          this.logger.warn({ err, path: full }, "Skipping invalid hook definition");
        }
      }
      this.userHooks = loaded;
    } catch (err) {
      this.logger.warn({ err }, "Failed to enumerate hook definitions (starting empty)");
      this.userHooks = [];
    }
  }

  private async loadState(): Promise<void> {
    try {
      const raw = await fs.readFile(this.stateFile, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") this.state = parsed as PersistedState;
    } catch {
      this.state = {};
    }
  }

  private ensureBuiltinDefaults(): void {
    // Built-ins are enabled by default the first time they appear. A user
    // who explicitly toggled one off keeps that preference.
    for (const hook of buildBuiltinHooks()) {
      if (this.state[hook.id] === undefined) {
        this.state[hook.id] = { enabled: true };
      }
    }
  }

  private saveInFlight: Promise<void> = Promise.resolve();
  private async saveState(): Promise<void> {
    // Serialize writes — concurrent recordFire calls were racing on
    // `.tmp → final` rename and crashing the loser with ENOENT.
    const next = this.saveInFlight.then(async () => {
      const tmp = `${this.stateFile}.${process.pid}.${Date.now()}.tmp`;
      await fs.mkdir(path.dirname(this.stateFile), { recursive: true });
      await fs.writeFile(tmp, JSON.stringify(this.state, null, 2), "utf8");
      await fs.rename(tmp, this.stateFile);
    });
    this.saveInFlight = next.catch(() => undefined);
    return next;
  }

  /** All hooks (built-in + user), with current runtime state. */
  list(): HookWithState[] {
    const defs = [...buildBuiltinHooks(), ...this.userHooks];
    return defs.map((d) => ({ definition: d, state: this.stateFor(d.id) }));
  }

  get(id: string): HookWithState | null {
    const entry = this.list().find((h) => h.definition.id === id);
    return entry ?? null;
  }

  private stateFor(id: string) {
    const s = this.state[id] ?? {};
    return {
      enabled: s.enabled ?? false,
      lastFiredAt: s.lastFiredAt,
      firedCount: s.firedCount,
    };
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const entry = this.get(id);
    if (!entry) throw new Error(`Unknown hook: ${id}`);
    this.state[id] = { ...(this.state[id] ?? {}), enabled };
    await this.saveState();
    this.events.emit("changed", { id });
  }

  /** Create or update a user hook. Rejects attempts to overwrite built-ins. */
  async upsertUserHook(hook: HubcodeHook): Promise<void> {
    if (BUILTIN_HOOK_IDS.has(hook.id) || hook.author === "builtin") {
      throw new Error(`Cannot overwrite built-in hook: ${hook.id}`);
    }
    const parsed = HubcodeHookSchema.parse({ ...hook, author: hook.author || "user" });
    const filePath = path.join(this.definitionsDir, `${parsed.id}.json`);
    const tmp = `${filePath}.tmp`;
    await fs.mkdir(this.definitionsDir, { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(parsed, null, 2), "utf8");
    await fs.rename(tmp, filePath);
    const idx = this.userHooks.findIndex((h) => h.id === parsed.id);
    if (idx >= 0) this.userHooks[idx] = parsed;
    else this.userHooks.push(parsed);
    if (this.state[parsed.id] === undefined) {
      this.state[parsed.id] = { enabled: true };
      await this.saveState();
    }
    this.events.emit("changed", { id: parsed.id });
  }

  async deleteUserHook(id: string): Promise<void> {
    if (BUILTIN_HOOK_IDS.has(id)) {
      throw new Error(`Cannot delete built-in hook: ${id}`);
    }
    this.userHooks = this.userHooks.filter((h) => h.id !== id);
    const filePath = path.join(this.definitionsDir, `${id}.json`);
    await fs.unlink(filePath).catch(() => undefined);
    delete this.state[id];
    await this.saveState();
    this.events.emit("changed", { id });
  }

  /**
   * Telemetry tick — fire-and-forget. Persisted lazily (batched by the next
   * save). The hook script is the source of truth for the firedCount; the
   * daemon just records.
   */
  async recordFire(id: string): Promise<void> {
    const existing = this.state[id] ?? {};
    this.state[id] = {
      ...existing,
      lastFiredAt: new Date().toISOString(),
      firedCount: (existing.firedCount ?? 0) + 1,
    };
    await this.saveState().catch((err) =>
      this.logger.debug({ err, id }, "hook telemetry save failed"),
    );
    // Telemetry ticks get their own event so the Settings UI refreshes
    // without re-triggering the Claude Code adapter sync (which writes to
    // ~/.claude/settings.json and would churn on every tool call).
    this.events.emit("telemetry", { id });
  }

  onChange(listener: (event: { id: string }) => void): () => void {
    this.events.on("changed", listener);
    return () => this.events.off("changed", listener);
  }

  /** Fire-only telemetry tick — separate from `changed` to avoid re-syncing adapters. */
  onTelemetry(listener: (event: { id: string }) => void): () => void {
    this.events.on("telemetry", listener);
    return () => this.events.off("telemetry", listener);
  }
}
