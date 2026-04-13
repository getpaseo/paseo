import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Logger } from "pino";

import { resolvePaseoHome } from "../../../paseo-home.js";

export const SESSION_MAP_FILE_NAME = "opencode-session-map.json";

export interface SessionAgentMapSnapshot {
  [sessionId: string]: string;
}

export interface SessionAgentMapOptions {
  paseoHome?: string;
  logger?: Logger;
}

export class SessionAgentMap {
  private readonly filePath: string;
  private readonly state = new Map<string, string>();
  private readonly logger?: Logger;

  constructor(options: SessionAgentMapOptions = {}) {
    const home = options.paseoHome ?? resolvePaseoHome();
    this.filePath = join(home, SESSION_MAP_FILE_NAME);
    this.logger = options.logger;
    this.loadFromDisk();
  }

  get path(): string {
    return this.filePath;
  }

  set(sessionId: string, agentId: string): void {
    this.state.set(sessionId, agentId);
    this.persist();
  }

  delete(sessionId: string): void {
    if (this.state.delete(sessionId)) {
      this.persist();
    }
  }

  get(sessionId: string): string | undefined {
    return this.state.get(sessionId);
  }

  size(): number {
    return this.state.size;
  }

  snapshot(): SessionAgentMapSnapshot {
    return Object.fromEntries(this.state);
  }

  clear(): void {
    const hadState = this.state.size > 0;
    this.state.clear();
    if (!hadState && !existsSync(this.filePath)) {
      return;
    }
    try {
      unlinkSync(this.filePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "ENOENT") {
        this.logger?.warn({ err: error, path: this.filePath }, "Failed to clear session map file");
      }
    }
  }

  private loadFromDisk(): void {
    if (!existsSync(this.filePath)) {
      return;
    }
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [sessionId, agentId] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof agentId === "string" && agentId.length > 0) {
            this.state.set(sessionId, agentId);
          }
        }
      }
    } catch (error) {
      this.logger?.warn(
        { err: error, path: this.filePath },
        "Failed to read session map; starting empty",
      );
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const payload = JSON.stringify(this.snapshot(), null, 2);
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now().toString(36)}`;
    try {
      writeFileSync(tmp, payload, "utf8");
      renameSync(tmp, this.filePath);
    } catch (error) {
      this.logger?.error({ err: error, path: this.filePath }, "Failed to persist session map");
      try {
        unlinkSync(tmp);
      } catch {
        // best effort
      }
    }
  }
}
