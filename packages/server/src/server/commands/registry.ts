import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";

import { buildBuiltinCommands, BUILTIN_COMMAND_IDS } from "./builtins.js";
import { HubcodeCommandSchema, type CommandWithState, type HubcodeCommand } from "./types.js";

/**
 * Storage layout (under `<HUBCODE_HOME>/commands/`):
 *
 *   definitions/<id>.json    — one user-authored command per file
 *   state.json               — { [id]: { enabled } }
 *
 * Built-ins live only in memory; user toggles are persisted in state.json.
 */

export interface CommandRegistryDeps {
  logger: Logger;
  hubcodeHome: string;
}

interface PersistedState {
  [id: string]: { enabled?: boolean };
}

export class CommandRegistry {
  private readonly logger: Logger;
  private readonly definitionsDir: string;
  private readonly stateFile: string;
  private readonly events = new EventEmitter();
  private userCommands: HubcodeCommand[] = [];
  private state: PersistedState = {};
  private loaded = false;
  private saveInFlight: Promise<void> = Promise.resolve();

  constructor(deps: CommandRegistryDeps) {
    this.logger = deps.logger.child({ module: "command-registry" });
    const root = path.join(deps.hubcodeHome, "commands");
    this.definitionsDir = path.join(root, "definitions");
    this.stateFile = path.join(root, "state.json");
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    await fs.mkdir(this.definitionsDir, { recursive: true });
    await this.loadUserCommands();
    await this.loadState();
    this.ensureBuiltinDefaults();
    this.loaded = true;
  }

  private async loadUserCommands(): Promise<void> {
    try {
      const entries = await fs.readdir(this.definitionsDir);
      const loaded: HubcodeCommand[] = [];
      for (const entry of entries) {
        if (!entry.endsWith(".json")) continue;
        const full = path.join(this.definitionsDir, entry);
        try {
          const raw = await fs.readFile(full, "utf8");
          const parsed = HubcodeCommandSchema.parse(JSON.parse(raw));
          if (parsed.author === "builtin") {
            this.logger.warn({ id: parsed.id }, "Skipping user command with builtin author");
            continue;
          }
          loaded.push(parsed);
        } catch (err) {
          this.logger.warn({ err, path: full }, "Skipping invalid command definition");
        }
      }
      this.userCommands = loaded;
    } catch (err) {
      this.logger.warn({ err }, "Failed to enumerate command definitions");
      this.userCommands = [];
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
    for (const cmd of buildBuiltinCommands()) {
      if (this.state[cmd.id] === undefined) this.state[cmd.id] = { enabled: true };
    }
  }

  private async saveState(): Promise<void> {
    const next = this.saveInFlight.then(async () => {
      const tmp = `${this.stateFile}.${process.pid}.${Date.now()}.tmp`;
      await fs.mkdir(path.dirname(this.stateFile), { recursive: true });
      await fs.writeFile(tmp, JSON.stringify(this.state, null, 2), "utf8");
      await fs.rename(tmp, this.stateFile);
    });
    this.saveInFlight = next.catch(() => undefined);
    return next;
  }

  list(): CommandWithState[] {
    const defs = [...buildBuiltinCommands(), ...this.userCommands];
    return defs.map((d) => ({
      definition: d,
      state: { enabled: this.state[d.id]?.enabled ?? false },
    }));
  }

  get(id: string): CommandWithState | null {
    return this.list().find((c) => c.definition.id === id) ?? null;
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const entry = this.get(id);
    if (!entry) throw new Error(`Unknown command: ${id}`);
    this.state[id] = { ...(this.state[id] ?? {}), enabled };
    await this.saveState();
    this.events.emit("changed", { id });
  }

  async upsertUserCommand(cmd: HubcodeCommand): Promise<void> {
    if (BUILTIN_COMMAND_IDS.has(cmd.id) || cmd.author === "builtin") {
      throw new Error(`Cannot overwrite built-in command: ${cmd.id}`);
    }
    const parsed = HubcodeCommandSchema.parse({ ...cmd, author: cmd.author || "user" });
    const filePath = path.join(this.definitionsDir, `${parsed.id}.json`);
    const tmp = `${filePath}.tmp`;
    await fs.mkdir(this.definitionsDir, { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(parsed, null, 2), "utf8");
    await fs.rename(tmp, filePath);
    const idx = this.userCommands.findIndex((c) => c.id === parsed.id);
    if (idx >= 0) this.userCommands[idx] = parsed;
    else this.userCommands.push(parsed);
    if (this.state[parsed.id] === undefined) {
      this.state[parsed.id] = { enabled: true };
      await this.saveState();
    }
    this.events.emit("changed", { id: parsed.id });
  }

  async deleteUserCommand(id: string): Promise<void> {
    if (BUILTIN_COMMAND_IDS.has(id)) {
      throw new Error(`Cannot delete built-in command: ${id}`);
    }
    this.userCommands = this.userCommands.filter((c) => c.id !== id);
    const filePath = path.join(this.definitionsDir, `${id}.json`);
    await fs.unlink(filePath).catch(() => undefined);
    delete this.state[id];
    await this.saveState();
    this.events.emit("changed", { id });
  }

  onChange(listener: (event: { id: string }) => void): () => void {
    this.events.on("changed", listener);
    return () => this.events.off("changed", listener);
  }
}
