import type { ProviderError, ProviderLaunch } from "@getpaseo/plugin/server/provider";
import path from "node:path";

export class MuseError extends Error {
  constructor(
    readonly kind: string,
    message: string,
    readonly diagnostic?: string,
    readonly reason?: string,
  ) {
    super(message);
    this.name = "MuseError";
  }
  toProviderError(): ProviderError {
    return { code: this.kind, message: this.message, diagnostic: this.diagnostic };
  }
}

export function classifyExit(
  code: number | null,
  signal: string | null,
  stderr: string,
): MuseError {
  const kinds: Record<number, string> = {
    0: "cleanExit",
    2: "usage",
    3: "credentials",
    4: "leaseHeld",
    5: "surfaceOff",
  };
  const kind = code === null ? "crash" : (kinds[code] ?? "crash");
  return new MuseError(kind, `Muse host exited (${code ?? signal}). ${stderr}`);
}

function isUnavailableReviewer(message: string): boolean {
  return message.includes("automated reviewer is unavailable");
}

export function actionableError(error: unknown, launch: ProviderLaunch): ProviderError {
  if (!(error instanceof Error)) return { code: "muse", message: String(error) };
  // Muse 1.4.1 reports this profile failure as internal, without a specific error kind.
  if (
    error instanceof MuseError &&
    error.kind === "internal" &&
    isUnavailableReviewer(error.message)
  ) {
    const configHome = launch.env.XDG_CONFIG_HOME ?? path.join(launch.env.HOME ?? "~", ".config");
    return {
      code: "defaultProfileUnavailable",
      message: `Change permissions.default_profile in ${path.join(configHome, "muse/settings.json")}: the automated reviewer is unavailable on this host.`,
    };
  }
  if (error instanceof MuseError && error.reason === "compaction_unavailable") {
    return {
      code: error.kind,
      message:
        "Muse cannot compact this session with its current model configuration. Ensure Muse has a context limit for the selected model (context_compaction.provider_context_limit_tokens).",
      diagnostic: error.message,
    };
  }
  if (error instanceof MuseError && error.kind === "sessionNotFound") {
    return { code: error.kind, message: "This Muse session no longer exists. Create a new agent." };
  }
  if (error instanceof MuseError && error.kind === "authRequired") {
    return { code: error.kind, message: "Run `muse login` or set META_API_KEY." };
  }
  // Muse 1.4.1 reports this bootstrap failure as internal, without a specific error kind.
  if (
    error instanceof MuseError &&
    error.kind === "internal" &&
    error.message.includes("UnsafePath")
  ) {
    const dataHome = launch.env.XDG_DATA_HOME ?? path.join(launch.env.HOME ?? "~", ".local/share");
    return {
      code: "unsafePath",
      message: `Muse data directory ${path.join(dataHome, "muse")} requires mode 0700. Set its permissions before retrying.`,
    };
  }
  if (error instanceof MuseError) return error.toProviderError();
  return { code: "muse", message: error.message };
}
