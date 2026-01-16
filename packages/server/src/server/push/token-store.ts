import type pino from "pino";

/**
 * Simple in-memory store for Expo push tokens.
 * Tokens are used to send push notifications when all clients are stale.
 */
export class PushTokenStore {
  private readonly logger: pino.Logger;
  private tokens: Set<string> = new Set();

  constructor(logger: pino.Logger) {
    this.logger = logger.child({ component: "token-store" });
  }

  addToken(token: string): void {
    this.tokens.add(token);
    this.logger.debug({ total: this.tokens.size }, "Added token");
  }

  removeToken(token: string): void {
    const deleted = this.tokens.delete(token);
    if (deleted) {
      this.logger.debug({ total: this.tokens.size }, "Removed token");
    }
  }

  getAllTokens(): string[] {
    return Array.from(this.tokens);
  }
}
