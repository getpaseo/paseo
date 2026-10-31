import {
  negotiateProviderCapabilities,
  type ProviderConnection,
  type ProviderRegistration,
  type ProviderStatus,
} from "@getpaseo/plugin/server/provider";
import { ZCODE_CAPABILITIES } from "./capabilities.js";
import {
  ZCODE_NOT_FOUND_DIAGNOSTIC,
  defaultDesktopRoots,
  listDesktopAppRoots,
  resolveZCodeLaunch,
  type ZCodeLaunch,
} from "./internal/binary.js";

export function createZCodeProvider(): ProviderRegistration {
  return {
    id: "zcode",
    label: "ZCode",
    description: "ZCode agent on your host, driven over its app-server protocol",
    icon: "icon.svg",
    async resolveCommand() {
      return resolveCommand();
    },
    async status({ launch }): Promise<ProviderStatus> {
      if (!launch) {
        return { available: false, diagnostic: ZCODE_NOT_FOUND_DIAGNOSTIC };
      }
      return { available: true, diagnostic: `ZCode resolved to ${launch.command}` };
    },
    async connect(request) {
      const negotiated = negotiateProviderCapabilities(request.capabilities, ZCODE_CAPABILITIES);
      return createConnection(negotiated);
    },
  };
}

/**
 * The daemon probes availability whenever it lists providers and before every
 * connection. Resolution scans PATH and the desktop app roots, so the result is
 * memoized briefly instead of repeating the scan on every probe.
 */
const RESOLUTION_CACHE_MS = 5_000;
let cached: { at: number; value: ZCodeLaunch | undefined } | undefined;

async function resolveLaunch(): Promise<ZCodeLaunch | undefined> {
  const now = Date.now();
  if (cached && now - cached.at < RESOLUTION_CACHE_MS) return cached.value;
  const value = await resolveZCodeLaunch({
    pathEntries: (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":"),
    env: process.env,
    desktopRoots: await listDesktopAppRoots(defaultDesktopRoots()),
  });
  cached = { at: now, value };
  return value;
}

/**
 * The desktop app's bundled runtime needs two environment variables the daemon
 * does not know about: `ELECTRON_RUN_AS_NODE`, so the Electron binary runs the
 * bundle as plain Node, and the path of the built-in provider config, without
 * which the app-server exits before it answers anything.
 *
 * The `resolveCommand` hook carries the command and its arguments only, so the
 * launch environment is exposed here for the connection layer to merge into the
 * child process environment.
 */
export function zcodeLaunchEnv(): Readonly<Record<string, string>> {
  return cached?.value?.env ?? {};
}

async function resolveCommand(): Promise<readonly [string, ...string[]] | undefined> {
  const launch = await resolveLaunch();
  return launch ? ([launch.command, ...launch.args] as const) : undefined;
}

function createConnection(_capabilities: readonly string[]): ProviderConnection {
  throw new Error("ZCode connection is not wired yet");
}
