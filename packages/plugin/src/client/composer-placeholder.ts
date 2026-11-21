export interface PluginComposerPlaceholderContribution {
  /** Agent whose empty chat composer shows this text. */
  agentId: string;
  /** Shown only while the composer draft is empty. Whitespace-only text clears it. */
  text: string;
}

export interface PluginComposerPlaceholderRegistration {
  /** Replaces the text in place. Whitespace-only text clears it until the next update. */
  update(text: string): void;
  /** Idempotent. Later updates do nothing. */
  remove(): void;
}
