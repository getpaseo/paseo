// Applies the demo change to a checkout of the Paseo repository.
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = process.argv[2];
const client = path.join(repo, "packages/client/src");

copyFileSync(
  path.join(here, "reconnect-delay.ts"),
  path.join(client, "connection/reconnect-delay.ts"),
);
copyFileSync(
  path.join(here, "reconnect-delay.test.ts"),
  path.join(client, "connection/reconnect-delay.test.ts"),
);

function edit(file, pairs) {
  let text = readFileSync(file, "utf8");
  for (const [from, to] of pairs) {
    if (!text.includes(from)) throw new Error(`Missing anchor in ${file}: ${from.slice(0, 60)}`);
    text = text.replace(from, to);
  }
  writeFileSync(file, text);
}

edit(path.join(client, "daemon-client.ts"), [
  [
    `import { CreationClient } from "./creation/index.js";\n`,
    `import { CreationClient } from "./creation/index.js";\nimport { getReconnectDelayMs } from "./connection/reconnect-delay.js";\n`,
  ],
  [
    `  private reconnectAttempt = 0;\n`,
    `  private reconnectAttempt = 0;\n  private nextReconnectDelay: { attempt: number; delayMs: number } | null = null;\n`,
  ],
  [
    `              nextRetryAt: new Date(
                Date.now() +
                  Math.min(
                    (this.config.reconnect?.baseDelayMs ?? DEFAULT_RECONNECT_BASE_DELAY_MS) *
                      2 ** this.reconnectAttempt,
                    this.config.reconnect?.maxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS,
                  ),
              ).toISOString(),
`,
    `              nextRetryAt: new Date(Date.now() + this.getNextReconnectDelayMs()).toISOString(),
`,
  ],
  [
    `  private armReconnectTimer(): void {
    const attempt = this.reconnectAttempt;
    const baseDelay = this.config.reconnect?.baseDelayMs ?? DEFAULT_RECONNECT_BASE_DELAY_MS;
    const maxDelay = this.config.reconnect?.maxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS;
    const delay = Math.min(baseDelay * 2 ** attempt, maxDelay);
`,
    `  // The countdown and the timer must agree, so each attempt draws its jitter once.
  private getNextReconnectDelayMs(): number {
    const attempt = this.reconnectAttempt;
    if (this.nextReconnectDelay?.attempt !== attempt) {
      this.nextReconnectDelay = {
        attempt,
        delayMs: getReconnectDelayMs(attempt, {
          baseDelayMs: this.config.reconnect?.baseDelayMs ?? DEFAULT_RECONNECT_BASE_DELAY_MS,
          maxDelayMs: this.config.reconnect?.maxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS,
        }),
      };
    }
    return this.nextReconnectDelay.delayMs;
  }

  private armReconnectTimer(): void {
    const attempt = this.reconnectAttempt;
    const delay = this.getNextReconnectDelayMs();
`,
  ],
]);

edit(path.join(repo, "CHANGELOG.md"), [
  [
    `# Changelog\n\n`,
    `# Changelog\n\n## Unreleased\n\n### Fixed\n\n- Spread reconnect attempts after a relay restart instead of retrying every client at once\n\n`,
  ],
]);
