import {
  execCommand,
  spawnProcess,
  terminateProcess,
  type TunnelProviderRegistration,
} from "@getpaseo/plugin/server";

const URL_PATTERN = /https:\/\/[a-z0-9.-]+/i;

function formatHostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

export function createCustomTunnelProvider(): TunnelProviderRegistration {
  const binary = process.env.CUSTOM_TUNNEL_BIN || "custom-tunnel";

  return {
    id: "custom-tunnel",
    label: "Custom Tunnel",
    description: "Expose a local HTTP host and port through a custom CLI.",
    docsUrl: "https://example.com/docs/custom-tunnel",

    async status({ signal }) {
      try {
        const { stdout } = await execCommand(binary, ["--version"], { signal, timeout: 5_000 });
        return { status: "available", detail: stdout.trim() || undefined };
      } catch {
        return {
          status: "unavailable",
          reason: `${binary} is not installed or not on PATH.`,
          installUrl: "https://example.com/install",
          fixHint: `Install ${binary} or set CUSTOM_TUNNEL_BIN in the daemon environment.`,
        };
      }
    },

    async open(target, { report, signal }) {
      report({ type: "connecting" });

      const child = spawnProcess(
        binary,
        ["http", `${formatHostForUrl(target.host)}:${target.port}`],
        {
          stdio: "pipe",
        },
      );

      let ready = false;
      const onOutput = (chunk: Buffer | string) => {
        if (ready || signal.aborted) return;
        const match = URL_PATTERN.exec(String(chunk));
        if (!match) return;
        ready = true;
        report({ type: "ready", url: match[0], stability: "ephemeral" });
      };

      child.stdout.on("data", onOutput);
      child.stderr.on("data", onOutput);

      const onAbort = () => {
        void terminateProcess(child, "SIGTERM").catch(() => undefined);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();

      try {
        const code = await new Promise<number | null>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", (exitCode) => resolve(exitCode));
        });

        if (signal.aborted) {
          report({ type: "closed", reason: "aborted" });
          return;
        }
        if (!ready || (code !== null && code !== 0)) {
          throw new Error(`${binary} exited with code ${code ?? "null"}`);
        }
        report({ type: "closed" });
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    },
  };
}
