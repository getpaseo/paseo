import { createServer, type Server, type Socket } from "node:net";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { shellQuote } from "./remote-daemon.js";

/**
 * Which secret SSH is asking for. The raw prompt is the only signal SSH gives,
 * and the two need visibly different treatment: one unlocks a local key file,
 * the other is the remote account's password. Classifying here means the UI
 * does not have to parse English prompt text.
 */
export type AskpassKind = "passphrase" | "password";

export interface AskpassRequest {
  /** SSH's own prompt, verbatim — carries the key path or `user@host`. */
  prompt: string;
  kind: AskpassKind;
}

export interface AskpassChannelOptions {
  /**
   * Resolve with the secret, or `null` when the user declines. Declining
   * aborts {@link AskpassChannel.signal}, which the tunnel uses to stop
   * immediately rather than letting SSH burn its remaining attempts.
   */
  onPrompt: (request: AskpassRequest) => Promise<string | null>;
  /**
   * How long to wait for an answer before treating the prompt as declined.
   * Without this a prompt nobody is listening for would hang SSH forever.
   */
  promptTimeoutMs?: number;
}

export interface AskpassChannel {
  /** Path to hand SSH as `SSH_ASKPASS`. */
  readonly askpassPath: string;
  /** Aborts as soon as a prompt is declined or times out. */
  readonly signal: AbortSignal;
  close(): void;
}

const DEFAULT_PROMPT_TIMEOUT_MS = 120_000;

export function classifyAskpassPrompt(prompt: string): AskpassKind {
  return /passphrase/i.test(prompt) ? "passphrase" : "password";
}

/**
 * The program SSH runs. It cannot be the Node helper directly — SSH_ASKPASS
 * must be an executable, and under Electron the runtime is the app binary in
 * Node mode. `ELECTRON_RUN_AS_NODE` is inert for a plain `node`, so one shape
 * serves both the desktop app and the CLI.
 */
function buildWrapperScript(execPath: string, helperPath: string): string {
  return `#!/bin/sh
ELECTRON_RUN_AS_NODE=1 exec ${shellQuote(execPath)} ${shellQuote(helperPath)} "$@"
`;
}

/**
 * Runs as a child of `ssh`: hands the prompt to Paseo over the socket and
 * prints whatever comes back on stdout, which is where SSH reads the secret
 * from. Exiting non-zero on refusal is not itself meaningful to SSH — it
 * ignores the status — but it keeps an empty answer from being offered as a
 * password.
 *
 * Written to disk at runtime rather than shipped, so there is no packaged
 * asset to resolve inside an asar archive.
 */
function buildHelperScript(socketPath: string): string {
  return `"use strict";
const net = require("node:net");
const socketPath = ${JSON.stringify(socketPath)};
const prompt = process.argv[2] ?? "";

const socket = net.connect(socketPath);
let buffered = "";

socket.on("connect", () => {
  socket.write(JSON.stringify({ prompt }) + "\\n");
});

socket.on("data", (chunk) => {
  buffered += chunk.toString("utf8");
  const newline = buffered.indexOf("\\n");
  if (newline < 0) return;
  let message;
  try {
    message = JSON.parse(buffered.slice(0, newline));
  } catch {
    process.exit(1);
  }
  if (message && message.ok === true && typeof message.secret === "string") {
    process.stdout.write(message.secret, () => process.exit(0));
    return;
  }
  process.exit(1);
});

// No listener, a closed channel, or a refused connection all mean we cannot
// answer; exiting beats hanging the SSH process indefinitely.
socket.on("error", () => process.exit(1));
socket.on("close", () => process.exit(1));
`;
}

/**
 * A private channel that lets Paseo answer SSH's password prompts itself,
 * instead of shelling out to `zenity`, `kdialog`, or `osascript`.
 *
 * SSH will only take a secret from a program's stdout, so there is still a
 * small program — but all it does is relay. The prompt travels to whatever UI
 * the caller owns and the answer comes back, which means the dialog is Paseo's
 * own: styled, localized, and able to say whether it wants a key passphrase or
 * an account password.
 *
 * Everything lives in a private `mkdtemp` directory (mode 0700), so the socket
 * is not reachable by other users on the machine.
 */
export function createAskpassChannel(options: AskpassChannelOptions): Promise<AskpassChannel> {
  const dir = mkdtempSync(path.join(tmpdir(), "paseo-askpass-"));
  const socketPath = path.join(dir, "askpass.sock");
  const helperPath = path.join(dir, "askpass-helper.cjs");
  const askpassPath = path.join(dir, "askpass.sh");
  const timeoutMs = options.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS;

  writeFileSync(helperPath, buildHelperScript(socketPath), { mode: 0o600 });
  writeFileSync(askpassPath, buildWrapperScript(process.execPath, helperPath), { mode: 0o700 });
  chmodSync(askpassPath, 0o700);

  const controller = new AbortController();

  const handleConnection = (socket: Socket): void => {
    let buffered = "";
    socket.setEncoding("utf8");
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk: string) => {
      buffered += chunk;
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      const line = buffered.slice(0, newline);
      buffered = "";

      let prompt: string;
      try {
        const parsed: unknown = JSON.parse(line);
        prompt =
          parsed && typeof parsed === "object" && typeof (parsed as { prompt?: unknown }).prompt
            ? String((parsed as { prompt: string }).prompt)
            : "";
      } catch {
        socket.end(`${JSON.stringify({ ok: false })}\n`);
        return;
      }

      const decline = (): void => {
        socket.end(`${JSON.stringify({ ok: false })}\n`);
        controller.abort();
      };

      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        decline();
      }, timeoutMs);
      timer.unref();

      void options
        .onPrompt({ prompt, kind: classifyAskpassPrompt(prompt) })
        .then((secret) => {
          if (settled) return undefined;
          settled = true;
          clearTimeout(timer);
          if (secret === null) {
            decline();
            return undefined;
          }
          socket.end(`${JSON.stringify({ ok: true, secret })}\n`);
          return undefined;
        })
        .catch(() => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          decline();
        });
    });
  };

  const server: Server = createServer(handleConnection);

  return new Promise<AskpassChannel>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      server.on("error", () => {
        // A dead channel just means prompts go unanswered; the tunnel's own
        // failure path reports that far more usefully than a crash here.
      });
      resolve({
        askpassPath,
        signal: controller.signal,
        close: () => {
          server.close();
          try {
            rmSync(dir, { recursive: true, force: true });
          } catch {
            // Best-effort cleanup.
          }
        },
      });
    });
  });
}
