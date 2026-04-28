import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";

import { buildBuiltinRules, BUILTIN_RULE_IDS } from "./builtins.js";
import { HubcodeRuleSchema, type HubcodeRule, type RuleWithState } from "./types.js";

export interface RuleRegistryDeps {
  logger: Logger;
  hubcodeHome: string;
}

interface PersistedState {
  [id: string]: { enabled?: boolean };
}

export class RuleRegistry {
  private readonly logger: Logger;
  private readonly definitionsDir: string;
  private readonly stateFile: string;
  private readonly events = new EventEmitter();
  private userRules: HubcodeRule[] = [];
  private state: PersistedState = {};
  private loaded = false;
  private saveInFlight: Promise<void> = Promise.resolve();

  constructor(deps: RuleRegistryDeps) {
    this.logger = deps.logger.child({ module: "rule-registry" });
    const root = path.join(deps.hubcodeHome, "rules");
    this.definitionsDir = path.join(root, "definitions");
    this.stateFile = path.join(root, "state.json");
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    await fs.mkdir(this.definitionsDir, { recursive: true });
    await this.loadUserRules();
    await this.loadState();
    for (const r of buildBuiltinRules()) {
      if (this.state[r.id] === undefined) this.state[r.id] = { enabled: true };
    }
    this.loaded = true;
  }

  private async loadUserRules(): Promise<void> {
    try {
      const entries = await fs.readdir(this.definitionsDir);
      const loaded: HubcodeRule[] = [];
      for (const entry of entries) {
        if (!entry.endsWith(".json")) continue;
        const full = path.join(this.definitionsDir, entry);
        try {
          const raw = await fs.readFile(full, "utf8");
          const parsed = HubcodeRuleSchema.parse(JSON.parse(raw));
          if (parsed.author === "builtin") continue;
          loaded.push(parsed);
        } catch (err) {
          this.logger.warn({ err, path: full }, "Skipping invalid rule definition");
        }
      }
      this.userRules = loaded;
    } catch {
      this.userRules = [];
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

  list(): RuleWithState[] {
    const defs = [...buildBuiltinRules(), ...this.userRules];
    return defs.map((d) => ({
      definition: d,
      state: { enabled: this.state[d.id]?.enabled ?? false },
    }));
  }

  get(id: string): RuleWithState | null {
    return this.list().find((r) => r.definition.id === id) ?? null;
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const entry = this.get(id);
    if (!entry) throw new Error(`Unknown rule: ${id}`);
    this.state[id] = { ...(this.state[id] ?? {}), enabled };
    await this.saveState();
    this.events.emit("changed", { id });
  }

  async upsertUserRule(rule: HubcodeRule): Promise<void> {
    if (BUILTIN_RULE_IDS.has(rule.id) || rule.author === "builtin") {
      throw new Error(`Cannot overwrite built-in rule: ${rule.id}`);
    }
    const parsed = HubcodeRuleSchema.parse({ ...rule, author: rule.author || "user" });
    const filePath = path.join(this.definitionsDir, `${parsed.id}.json`);
    const tmp = `${filePath}.tmp`;
    await fs.mkdir(this.definitionsDir, { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(parsed, null, 2), "utf8");
    await fs.rename(tmp, filePath);
    const idx = this.userRules.findIndex((r) => r.id === parsed.id);
    if (idx >= 0) this.userRules[idx] = parsed;
    else this.userRules.push(parsed);
    if (this.state[parsed.id] === undefined) {
      this.state[parsed.id] = { enabled: true };
      await this.saveState();
    }
    this.events.emit("changed", { id: parsed.id });
  }

  async deleteUserRule(id: string): Promise<void> {
    if (BUILTIN_RULE_IDS.has(id)) throw new Error(`Cannot delete built-in rule: ${id}`);
    this.userRules = this.userRules.filter((r) => r.id !== id);
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
