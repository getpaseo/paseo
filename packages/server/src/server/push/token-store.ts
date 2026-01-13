/**
 * Simple in-memory store for Expo push tokens.
 * Tokens are used to send push notifications when all clients are stale.
 */
export class PushTokenStore {
  private tokens: Set<string> = new Set();

  addToken(token: string): void {
    this.tokens.add(token);
    console.log(`[PushTokenStore] Added token (total: ${this.tokens.size})`);
  }

  removeToken(token: string): void {
    const deleted = this.tokens.delete(token);
    if (deleted) {
      console.log(`[PushTokenStore] Removed token (total: ${this.tokens.size})`);
    }
  }

  getAllTokens(): string[] {
    return Array.from(this.tokens);
  }
}
