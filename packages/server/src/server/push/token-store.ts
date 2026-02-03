import type pino from "pino";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Store for Expo push tokens.
 *
 * Tokens are persisted to disk so pushes still work after daemon restarts.
 */
export class PushTokenStore {
  private readonly logger: pino.Logger;
  private tokens: Set<string> = new Set();
  private readonly filePath: string;

  constructor(logger: pino.Logger, filePath: string) {
    this.logger = logger.child({ component: "token-store" });
    this.filePath = filePath;
    this.loadFromDisk();
  }

  addToken(token: string): void {
    const normalized = token.trim();
    if (!normalized) return;
    if (this.tokens.has(normalized)) return;
    this.tokens.add(normalized);
    this.persist();
    this.logger.debug({ total: this.tokens.size }, "Added token");
  }

  removeToken(token: string): void {
    const normalized = token.trim();
    if (!normalized) return;
    const deleted = this.tokens.delete(normalized);
    if (deleted) {
      this.persist();
      this.logger.debug({ total: this.tokens.size }, "Removed token");
    }
  }

  getAllTokens(): string[] {
    return Array.from(this.tokens);
  }

  private loadFromDisk(): void {
    try {
      if (!existsSync(this.filePath)) {
        return;
      }
      const raw = readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as { tokens?: unknown };
      const tokens = Array.isArray(parsed.tokens)
        ? parsed.tokens.filter((t): t is string => typeof t === "string" && t.trim().length > 0)
        : [];
      this.tokens = new Set(tokens.map((t) => t.trim()));
      this.logger.info({ total: this.tokens.size }, "Loaded push tokens");
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.warn({ err }, "Failed to load push tokens");
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const tmpPath = `${this.filePath}.tmp`;
      const payload = JSON.stringify({ tokens: Array.from(this.tokens) }, null, 2) + "\n";
      writeFileSync(tmpPath, payload);
      renameSync(tmpPath, this.filePath);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.warn({ err }, "Failed to persist push tokens");
    }
  }
}
