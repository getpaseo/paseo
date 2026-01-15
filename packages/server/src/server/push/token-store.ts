import { getRootLogger } from "../logger.js";

const logger = getRootLogger().child({ module: "push", component: "token-store" });

/**
 * Simple in-memory store for Expo push tokens.
 * Tokens are used to send push notifications when all clients are stale.
 */
export class PushTokenStore {
  private tokens: Set<string> = new Set();

  addToken(token: string): void {
    this.tokens.add(token);
    logger.debug({ total: this.tokens.size }, "Added token");
  }

  removeToken(token: string): void {
    const deleted = this.tokens.delete(token);
    if (deleted) {
      logger.debug({ total: this.tokens.size }, "Removed token");
    }
  }

  getAllTokens(): string[] {
    return Array.from(this.tokens);
  }
}
