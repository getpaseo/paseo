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

interface ReleaseVersion {
  /** The version as written, such as `0.200.0-alpha.1`. */
  text: string;
  numbers: [number, number, number];
  /** True for a prerelease such as `-alpha.1`, which comes before the release itself. */
  prerelease: boolean;
}

function parseReleaseVersion(value: string): ReleaseVersion | null {
  const match = value.match(/\b(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?/);
  if (!match) return null;
  return {
    text: match[0],
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] !== undefined,
  };
}

/** Newer, older or the same release; `null` between two prereleases of one release. */
function compareReleases(latest: ReleaseVersion, installed: ReleaseVersion): number | null {
  for (let index = 0; index < 3; index += 1) {
    const difference = latest.numbers[index] - installed.numbers[index];
    if (difference !== 0) return difference;
  }
  if (latest.prerelease && installed.prerelease) return latest.text === installed.text ? 0 : null;
  if (installed.prerelease) return 1;
  if (latest.prerelease) return -1;
  return 0;
}

/**
 * Compares `major.minor.patch` releases, the scheme Claude Code, Codex and Pi publish. A
 * prerelease comes before the release with the same numbers.
 */
export function compareWithLatestRelease(input: {
  installed: string | null | undefined;
  latest: string;
}): ProviderUpdateCheck {
  const installed = input.installed ? parseReleaseVersion(input.installed) : null;
  const latest = parseReleaseVersion(input.latest);
  if (!installed) return { status: "unknown", message: "The installed version is not readable" };
  if (!latest) return { status: "unknown", message: `Unrecognized release ${input.latest}` };
  const order = compareReleases(latest, installed);
  if (order === null)
    return { status: "unknown", message: `Cannot compare ${installed.text} with ${latest.text}` };
  return order > 0
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
