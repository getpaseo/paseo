import {
  execCommand,
  type TunnelProviderRegistration,
  type TunnelProviderStatus,
} from "@getpaseo/plugin/server";

export const TAILSCALE_FUNNEL_PORTS = [443, 8443, 10000] as const;

const TAILSCALE_INSTALL_URL = "https://tailscale.com/download";
const TAILSCALE_FUNNEL_DOCS_URL = "https://tailscale.com/kb/1223/funnel";

export interface TailscaleFunnelProviderOptions {
  binary?: string;
  env?: NodeJS.ProcessEnv;
}

interface TailscaleStatusJson {
  BackendState?: unknown;
  Self?: {
    DNSName?: unknown;
    Capabilities?: unknown;
    CapMap?: unknown;
  };
}

interface TailscaleFunnelStatusJson {
  TCP?: Record<string, unknown>;
  Web?: Record<string, unknown>;
  AllowFunnel?: Record<string, unknown>;
}

function formatHostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function hasFunnelCapability(self: NonNullable<TailscaleStatusJson["Self"]>): boolean {
  if (Array.isArray(self.Capabilities)) {
    if (
      self.Capabilities.some(
        (capability) => typeof capability === "string" && /funnel/i.test(capability),
      )
    ) {
      return true;
    }
  }
  if (self.CapMap && typeof self.CapMap === "object" && !Array.isArray(self.CapMap)) {
    for (const [key, value] of Object.entries(self.CapMap)) {
      if (/funnel/i.test(key) && value !== false && value !== null && value !== undefined) {
        return true;
      }
    }
  }
  return false;
}

function parsePortFromKey(key: string): number | null {
  const direct = /^\d+$/.exec(key.trim());
  if (direct) {
    const value = Number(direct[0]);
    return Number.isInteger(value) ? value : null;
  }
  const hostPort = /:(\d+)$/.exec(key.trim());
  if (hostPort) {
    const value = Number(hostPort[1]);
    return Number.isInteger(value) ? value : null;
  }
  return null;
}

export function extractOccupiedFunnelPorts(raw: unknown): Set<number> {
  const occupied = new Set<number>();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return occupied;
  const status = raw as TailscaleFunnelStatusJson;

  if (status.TCP && typeof status.TCP === "object") {
    for (const key of Object.keys(status.TCP)) {
      const port = parsePortFromKey(key);
      if (port !== null) occupied.add(port);
    }
  }
  if (status.Web && typeof status.Web === "object") {
    for (const key of Object.keys(status.Web)) {
      const port = parsePortFromKey(key);
      if (port !== null) occupied.add(port);
    }
  }
  if (status.AllowFunnel && typeof status.AllowFunnel === "object") {
    for (const [key, enabled] of Object.entries(status.AllowFunnel)) {
      if (!enabled) continue;
      const port = parsePortFromKey(key);
      if (port !== null) occupied.add(port);
    }
  }
  return occupied;
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

export function createTailscaleFunnelProvider(
  options: TailscaleFunnelProviderOptions = {},
): TunnelProviderRegistration {
  const binary = options.binary ?? "tailscale";
  const env = options.env;
  const allocatedPorts = new Set<number>();
  let allocationTail: Promise<void> = Promise.resolve();

  async function withAllocationLock<T>(run: () => Promise<T>): Promise<T> {
    const previous = allocationTail;
    let release!: () => void;
    allocationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await run();
    } finally {
      release();
    }
  }

  async function probeStatus(
    signal?: AbortSignal,
  ): Promise<
    | { ok: true; dnsName: string; status: TunnelProviderStatus }
    | { ok: false; status: Extract<TunnelProviderStatus, { status: "unavailable" }> }
  > {
    let stdout: string;
    try {
      ({ stdout } = await execCommand(binary, ["status", "--json"], {
        env,
        signal,
        timeout: 5_000,
      }));
    } catch (error) {
      if (isNotFoundError(error)) {
        return {
          ok: false,
          status: {
            status: "unavailable",
            reason: `${binary} CLI is not installed or not on PATH.`,
            installUrl: TAILSCALE_INSTALL_URL,
            fixHint: "Install Tailscale and make sure the tailscale CLI is on PATH.",
          },
        };
      }
      return {
        ok: false,
        status: {
          status: "unavailable",
          reason: `Tailscale is not running or could not be queried: ${error instanceof Error ? error.message : String(error)}`,
          fixHint: "Start Tailscale and run `tailscale status` to verify connectivity.",
        },
      };
    }

    let parsed: TailscaleStatusJson;
    try {
      parsed = JSON.parse(stdout) as TailscaleStatusJson;
    } catch {
      return {
        ok: false,
        status: {
          status: "unavailable",
          reason: "Could not parse output from `tailscale status --json`.",
          fixHint: "Verify that your Tailscale CLI is up to date.",
        },
      };
    }

    const backendState = typeof parsed.BackendState === "string" ? parsed.BackendState : "unknown";
    if (backendState !== "Running") {
      return {
        ok: false,
        status: {
          status: "unavailable",
          reason: `Tailscale is not connected (state: ${backendState}).`,
          fixHint: "Run `tailscale up` and sign in to your tailnet.",
        },
      };
    }

    const self = parsed.Self;
    const dnsName =
      typeof self?.DNSName === "string" ? self.DNSName.trim().replace(/\.+$/, "") : "";
    if (!dnsName) {
      return {
        ok: false,
        status: {
          status: "unavailable",
          reason: "MagicDNS is not enabled for this Tailscale node.",
          fixHint: "Enable MagicDNS in the Tailscale admin console.",
        },
      };
    }

    if (!self || !hasFunnelCapability(self)) {
      return {
        ok: false,
        status: {
          status: "unavailable",
          reason: "Tailscale Funnel is not enabled for this node or tailnet.",
          installUrl: TAILSCALE_FUNNEL_DOCS_URL,
          fixHint:
            "Enable HTTPS certificates and Funnel in your Tailscale admin console and ACL policy.",
        },
      };
    }

    return {
      ok: true,
      dnsName,
      status: {
        status: "available",
        detail: dnsName,
      },
    };
  }

  async function inspectOccupiedPorts(signal?: AbortSignal): Promise<Set<number>> {
    try {
      const { stdout } = await execCommand(binary, ["funnel", "status", "--json"], {
        env,
        signal,
        timeout: 5_000,
      });
      const trimmed = stdout.trim();
      if (!trimmed) return new Set();
      return extractOccupiedFunnelPorts(JSON.parse(trimmed));
    } catch {
      return new Set();
    }
  }

  async function disableFunnelPort(port: number): Promise<void> {
    await withAllocationLock(async () => {
      try {
        await execCommand(binary, ["funnel", `--https=${port}`, "off"], {
          env,
          timeout: 10_000,
        });
      } catch {
        // Best-effort cleanup so teardown completes even if Tailscale stopped.
      } finally {
        allocatedPorts.delete(port);
      }
    });
  }

  return {
    id: "tailscale-funnel",
    label: "Tailscale Funnel",
    description: "Expose local HTTP endpoints on your Tailscale MagicDNS hostname via Funnel.",
    docsUrl: TAILSCALE_FUNNEL_DOCS_URL,

    async status({ signal }): Promise<TunnelProviderStatus> {
      const probe = await probeStatus(signal);
      return probe.status;
    },

    async open(target, { report, signal }): Promise<void> {
      report({ type: "connecting" });

      const probe = await probeStatus(signal);
      if (!probe.ok) {
        throw new Error(probe.status.reason);
      }

      const targetUrl = `http://${formatHostForUrl(target.host)}:${target.port}`;
      let assignedPort: number | null = null;

      await withAllocationLock(async () => {
        if (signal.aborted) return;
        const occupied = await inspectOccupiedPorts(signal);
        const freePort = TAILSCALE_FUNNEL_PORTS.find(
          (candidate) => !occupied.has(candidate) && !allocatedPorts.has(candidate),
        );
        if (freePort === undefined) {
          throw new Error(
            "All 3 Tailscale Funnel HTTPS ports (443, 8443, 10000) are already in use. Close an existing Funnel exposure before opening another.",
          );
        }
        allocatedPorts.add(freePort);
        try {
          await execCommand(binary, ["funnel", "--bg", `--https=${freePort}`, targetUrl], {
            env,
            signal,
            timeout: 15_000,
          });
          assignedPort = freePort;
        } catch (error) {
          allocatedPorts.delete(freePort);
          throw new Error(
            `Failed to start Tailscale Funnel on HTTPS port ${freePort}: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
      });

      if (assignedPort === null) {
        report({ type: "closed", reason: "aborted" });
        return;
      }

      const activePort = assignedPort;
      try {
        if (signal.aborted) {
          await disableFunnelPort(activePort);
          report({ type: "closed", reason: "aborted" });
          return;
        }

        const publicUrl =
          activePort === 443
            ? `https://${probe.dnsName}`
            : `https://${probe.dnsName}:${activePort}`;
        report({
          type: "ready",
          url: publicUrl,
          stability: "stable",
        });

        await waitForAbort(signal);
        await disableFunnelPort(activePort);
        report({ type: "closed", reason: "aborted" });
      } finally {
        allocatedPorts.delete(activePort);
      }
    },
  };
}
