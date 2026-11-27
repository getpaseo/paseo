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
const QUICK_TUNNEL_URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const NAMED_TUNNEL_READY_PATTERN = /registered tunnel connection|connection\s+\S+\s+registered/i;
const FORCE_KILL_DELAY_MS = 2_000;

export interface CloudflaredProviderOptions {
  readSettings?: () => Promise<CloudflaredSettings>;
  env?: NodeJS.ProcessEnv;
}

function formatHostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function normalizeHttpUrl(raw: string): string | null {
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function firstLine(text: string): string | undefined {
  const line = text
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  return line;
}

function redactSecret(text: string, secret?: string): string {
  if (!secret) return text;
  return text.split(secret).join("[REDACTED]");
}

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

  async function resolveConfig(): Promise<{
    binary: string;
    tunnelToken?: string;
    publicBaseUrl?: string;
    configError?: { reason: string; fixHint: string };
  }> {
    const values = await readSettings();
    const binary = values.binaryPath?.trim() || "cloudflared";
    const tunnelToken = values.tunnelToken?.trim() || undefined;
    const rawPublicBaseUrl = values.publicBaseUrl?.trim() || undefined;

    if (tunnelToken && !rawPublicBaseUrl) {
      return {
        binary,
        tunnelToken,
        configError: {
          reason: "Named Cloudflare Tunnel requires publicBaseUrl when tunnelToken is set.",
          fixHint:
            "Set publicBaseUrl in Cloudflare Tunnel settings, or clear tunnelToken to use quick tunnels.",
        },
      };
    }

    if (rawPublicBaseUrl) {
      const normalized = normalizeHttpUrl(rawPublicBaseUrl);
      if (!normalized) {
        return {
          binary,
          tunnelToken,
          configError: {
            reason: `Invalid publicBaseUrl "${rawPublicBaseUrl}". Expected an http(s) URL.`,
            fixHint: "Update publicBaseUrl to a valid https:// URL.",
          },
        };
      }
      return { binary, tunnelToken, publicBaseUrl: normalized };
    }

    return { binary, tunnelToken };
  }

  return {
    id: "cloudflared",
    label: "Cloudflare Tunnel",
    description:
      "Expose local HTTP targets directly with Cloudflare quick tunnels, or run a remotely configured named tunnel.",
    docsUrl: CLOUDFLARED_DOCS_URL,

    async status({ signal }): Promise<TunnelProviderStatus> {
      const config = await resolveConfig();
      if (config.configError) {
        return {
          status: "unavailable",
          reason: config.configError.reason,
          fixHint: config.configError.fixHint,
        };
      }
      try {
        const { stdout, stderr } = await execCommand(config.binary, ["--version"], {
          env,
          signal,
          timeout: 5_000,
        });
        const version = firstLine(stdout) ?? firstLine(stderr);
        const mode = config.tunnelToken ? "named tunnel" : "quick tunnel";
        return {
          status: "available",
          detail: version ? `${version} (${mode})` : mode,
        };
      } catch (error) {
        if (isNotFoundError(error)) {
          return {
            status: "unavailable",
            reason: `${config.binary} is not installed or not on PATH.`,
            installUrl: CLOUDFLARED_INSTALL_URL,
            fixHint: "Install cloudflared and make sure it is available on PATH.",
          };
        }
        return {
          status: "unavailable",
          reason: `Failed to query ${config.binary}: ${error instanceof Error ? error.message : String(error)}`,
          installUrl: CLOUDFLARED_INSTALL_URL,
          fixHint: "Verify that cloudflared runs cleanly from your shell.",
        };
      }
    },

    async open(target, { report, signal }): Promise<void> {
      const config = await resolveConfig();
      if (config.configError) {
        throw new Error(config.configError.reason);
      }

      const targetUrl = `http://${formatHostForUrl(target.host)}:${target.port}`;
      const isNamed = Boolean(config.tunnelToken && config.publicBaseUrl);
      const args = isNamed
        ? ["tunnel", "--no-autoupdate", "run"]
        : ["tunnel", "--no-autoupdate", "--url", targetUrl];
      const spawnEnv = isNamed
        ? { ...(env ?? process.env), TUNNEL_TOKEN: config.tunnelToken! }
        : env;

      report({ type: "connecting" });

      const child = spawnProcess(config.binary, args, {
        env: spawnEnv,
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
        lastOutputLine = redactSecret(line, config.tunnelToken);
        if (readyReported || signal.aborted) return;

        if (isNamed) {
          if (NAMED_TUNNEL_READY_PATTERN.test(line)) {
            readyReported = true;
            report({
              type: "ready",
              url: config.publicBaseUrl!,
              stability: "stable",
            });
          }
          return;
        }

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
              `${config.binary} is not installed or not on PATH. Install cloudflared and retry.`,
            );
          }
          throw new Error(redactSecret(result.spawnError.message, config.tunnelToken));
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
