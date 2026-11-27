import {
  execCommand,
  spawnProcess,
  terminateProcess,
  type TunnelProviderRegistration,
  type TunnelProviderStatus,
} from "@getpaseo/plugin/server";
import type { CloudflaredSettings } from "../shared/settings.js";

const CLOUDFLARED_INSTALL_URL =
  "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/";
const CLOUDFLARED_DOCS_URL =
  "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/";
// api.trycloudflare.com is the provisioning endpoint. It appears in errors, never as a tunnel URL.
const QUICK_TUNNEL_URL_PATTERN = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/i;
const FORCE_KILL_DELAY_MS = 2_000;

export interface CloudflaredProviderOptions {
  readSettings?: () => Promise<CloudflaredSettings>;
  env?: NodeJS.ProcessEnv;
}

function formatHostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function firstLine(text: string): string | undefined {
  const line = text
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  return line;
}

// Every launch passes `shell: false`: the CLI ships as an executable. With a shell, Windows runs a
// missing bare name through cmd.exe, which prints a localized "not recognized" error instead of
// failing the spawn with ENOENT. A `.cmd` given as a full path still runs through cmd.exe.
function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

export function createCloudflaredTunnelProvider(
  options: CloudflaredProviderOptions = {},
): TunnelProviderRegistration {
  const readSettings: () => Promise<CloudflaredSettings> =
    options.readSettings ?? (async () => ({}));
  const env = options.env;

  async function resolveBinary(): Promise<string> {
    const values = await readSettings();
    return values.binaryPath?.trim() || "cloudflared";
  }

  return {
    id: "cloudflared",
    label: "Cloudflare Tunnel",
    description: "Expose local HTTP targets with Cloudflare quick tunnels.",
    docsUrl: CLOUDFLARED_DOCS_URL,

    async status({ signal }): Promise<TunnelProviderStatus> {
      const binary = await resolveBinary();
      try {
        const { stdout, stderr } = await execCommand(binary, ["--version"], {
          env,
          shell: false,
          signal,
          timeout: 5_000,
        });
        const version = firstLine(stdout) ?? firstLine(stderr);
        return {
          status: "available",
          detail: version ? `${version} (quick tunnel)` : "quick tunnel",
        };
      } catch (error) {
        if (isNotFoundError(error)) {
          return {
            status: "unavailable",
            reason: `${binary} is not installed or not on PATH.`,
            installUrl: CLOUDFLARED_INSTALL_URL,
            fixHint: "Install cloudflared and make sure it is available on PATH.",
          };
        }
        return {
          status: "unavailable",
          reason: `Failed to query ${binary}: ${error instanceof Error ? error.message : String(error)}`,
          installUrl: CLOUDFLARED_INSTALL_URL,
          fixHint: "Verify that cloudflared runs cleanly from your shell.",
        };
      }
    },

    async open(target, { report, signal }): Promise<void> {
      const binary = await resolveBinary();
      const targetUrl = `http://${formatHostForUrl(target.host)}:${target.port}`;

      report({ type: "connecting" });

      const child = spawnProcess(binary, ["tunnel", "--no-autoupdate", "--url", targetUrl], {
        env,
        shell: false,
        stdio: "pipe",
      });

      let readyReported = false;
      let exited = false;
      let lastOutputLine = "";
      let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
      let stdoutRemainder = "";
      let stderrRemainder = "";

      const stopChild = () => {
        if (exited) return;
        void terminateProcess(child, "SIGTERM").catch(() => undefined);
        if (!forceKillTimer) {
          forceKillTimer = setTimeout(() => {
            if (!exited) {
              void terminateProcess(child, "SIGKILL").catch(() => undefined);
            }
          }, FORCE_KILL_DELAY_MS);
        }
      };

      const processLine = (rawLine: string) => {
        const line = rawLine.trim();
        if (!line) return;
        lastOutputLine = line;
        if (readyReported || signal.aborted) return;

        const match = QUICK_TUNNEL_URL_PATTERN.exec(line);
        if (match) {
          readyReported = true;
          report({
            type: "ready",
            url: match[0],
            stability: "ephemeral",
          });
        }
      };

      const consumeChunk = (stream: "stdout" | "stderr", chunk: Buffer | string) => {
        const text = (stream === "stdout" ? stdoutRemainder : stderrRemainder) + String(chunk);
        const lines = text.split(/\r?\n/);
        const remainder = lines.pop() ?? "";
        if (stream === "stdout") stdoutRemainder = remainder;
        else stderrRemainder = remainder;
        for (const line of lines) processLine(line);
      };

      child.stdout.on("data", (chunk) => consumeChunk("stdout", chunk));
      child.stderr.on("data", (chunk) => consumeChunk("stderr", chunk));

      const onAbort = () => stopChild();
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) stopChild();

      try {
        const result = await new Promise<{
          code: number | null;
          exitSignal: NodeJS.Signals | null;
          spawnError?: Error;
        }>((resolve) => {
          child.once("error", (error) => {
            exited = true;
            resolve({ code: null, exitSignal: null, spawnError: error });
          });
          child.once("close", (code, exitSignal) => {
            exited = true;
            if (stdoutRemainder) processLine(stdoutRemainder);
            if (stderrRemainder) processLine(stderrRemainder);
            resolve({ code, exitSignal });
          });
        });

        if (signal.aborted) {
          report({ type: "closed", reason: "aborted" });
          return;
        }

        if (result.spawnError) {
          if (isNotFoundError(result.spawnError)) {
            throw new Error(
              `${binary} is not installed or not on PATH. Install cloudflared and retry.`,
            );
          }
          throw result.spawnError;
        }

        if (!readyReported) {
          const detail = lastOutputLine ? `: ${lastOutputLine}` : "";
          throw new Error(
            `cloudflared exited before tunnel became ready (code ${result.code ?? "null"})${detail}`,
          );
        }

        if (result.code && result.code !== 0) {
          const detail = lastOutputLine ? `: ${lastOutputLine}` : "";
          const message = `cloudflared exited with code ${result.code}${detail}`;
          report({ type: "error", message, recoverable: false });
          throw new Error(message);
        }

        report({ type: "closed" });
      } finally {
        signal.removeEventListener("abort", onAbort);
        if (forceKillTimer) clearTimeout(forceKillTimer);
      }
    },
  };
}
