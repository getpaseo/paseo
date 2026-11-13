import { realpath } from "node:fs/promises";
import type { ProviderUpdateCheck } from "@getpaseo/plugin/server/provider";

/**
 * Returns the newest version a provider's release channel offers for the installed executable.
 * Built-in providers inject this so tests can answer without the network.
 */
export type LatestReleaseLookup = (input: {
  /** The executable the provider launches, symlinks resolved. */
  executablePath: string;
  signal: AbortSignal;
}) => Promise<string>;

type ReleaseVersion = [number, number, number];

function parseReleaseVersion(value: string): ReleaseVersion | null {
  const match = value.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function isNewer(latest: ReleaseVersion, installed: ReleaseVersion): boolean {
  for (let index = 0; index < 3; index += 1) {
    if (latest[index] !== installed[index]) return latest[index] > installed[index];
  }
  return false;
}

/** Compares `major.minor.patch` releases, the scheme Claude Code and Codex publish. */
export function compareWithLatestRelease(input: {
  installed: string | null | undefined;
  latest: string;
}): ProviderUpdateCheck {
  const installed = input.installed ? parseReleaseVersion(input.installed) : null;
  const latest = parseReleaseVersion(input.latest);
  if (!installed) return { status: "unknown", message: "The installed version is not readable" };
  if (!latest) return { status: "unknown", message: `Unrecognized release ${input.latest}` };
  return isNewer(latest, installed)
    ? { status: "available", versions: [input.latest.trim()] }
    : { status: "current" };
}

/** Resolves symlinks so Homebrew and npm installs show their real location. */
export async function resolveExecutablePath(executablePath: string): Promise<string> {
  try {
    return await realpath(executablePath);
  } catch {
    return executablePath;
  }
}

/** The cask name when the executable lives in a Homebrew Caskroom, such as `codex`. */
export function homebrewCaskOf(executablePath: string): string | null {
  return executablePath.match(/\/Caskroom\/([^/]+)\//)?.[1] ?? null;
}

async function fetchRelease(url: string, signal: AbortSignal): Promise<Response> {
  const response = await fetch(url, { signal, headers: { "User-Agent": "paseo" } });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response;
}

export async function fetchReleaseText(url: string, signal: AbortSignal): Promise<string> {
  return (await (await fetchRelease(url, signal)).text()).trim();
}

/** Reads a string field from a JSON release document. */
export async function fetchReleaseField(input: {
  url: string;
  field: string;
  signal: AbortSignal;
}): Promise<string> {
  const body: unknown = await (await fetchRelease(input.url, input.signal)).json();
  const value =
    body && typeof body === "object" ? (body as Record<string, unknown>)[input.field] : undefined;
  if (typeof value !== "string") throw new Error(`${input.url} has no ${input.field}`);
  return value;
}

/** The latest Homebrew cask version, which can lag the upstream release. */
export function fetchHomebrewCaskVersion(cask: string, signal: AbortSignal): Promise<string> {
  return fetchReleaseField({
    url: `https://formulae.brew.sh/api/cask/${encodeURIComponent(cask)}.json`,
    field: "version",
    signal,
  });
}
