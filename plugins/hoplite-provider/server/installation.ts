import { execCommand } from "@getpaseo/plugin/server";
import type {
  ProviderInstallation,
  ProviderInstallationLaunch,
  ProviderUpdateCheck,
} from "@getpaseo/plugin/server/provider";

/** The file Hoplite's installer and its own update check read for the current release. */
const LATEST_RELEASE_URL = "https://hoplite.sh/downloads/latest.json";

export type LatestHopliteRelease = (signal: AbortSignal) => Promise<string>;

type Release = [number, number, number];

function parseRelease(text: string): Release | null {
  const match = /\b(\d+)\.(\d+)\.(\d+)\b/.exec(text);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function isNewer(latest: Release, installed: Release): boolean {
  for (let index = 0; index < 3; index += 1) {
    if (latest[index] !== installed[index]) return latest[index] > installed[index];
  }
  return false;
}

async function fetchLatestRelease(signal: AbortSignal): Promise<string> {
  const response = await fetch(LATEST_RELEASE_URL, { signal });
  if (!response.ok) throw new Error(`${LATEST_RELEASE_URL} returned ${response.status}`);
  const body: unknown = await response.json();
  const version =
    body && typeof body === "object" ? (body as Record<string, unknown>).version : undefined;
  if (typeof version !== "string") throw new Error(`${LATEST_RELEASE_URL} has no version`);
  return version;
}

/**
 * Sessions run `hoplite acp` followed by any configured arguments. The version comes from the
 * part of the launch before `acp`, so `npx hoplite acp` reads `npx hoplite --version`.
 */
async function readVersion(
  launch: ProviderInstallationLaunch,
  signal: AbortSignal,
): Promise<string | undefined> {
  const acp = launch.args.indexOf("acp");
  const args = acp === -1 ? launch.args : launch.args.slice(0, acp);
  const { stdout } = await execCommand(launch.command, [...args, "--version"], {
    env: launch.env,
    timeout: 5000,
    maxBuffer: 8192,
    signal,
  });
  const firstLine = stdout.trim().split("\n")[0]?.trim();
  return /\b\d+\.\d+\.\d+\S*/.exec(stdout)?.[0] ?? (firstLine || undefined);
}

export function createHopliteInstallation(
  latestRelease: LatestHopliteRelease = fetchLatestRelease,
): ProviderInstallation {
  return {
    installUrl: "https://hoplite.sh/docs/cli#install",
    // The CLI does not update itself; its docs list the command for each install method.
    updateUrl: "https://hoplite.sh/docs/cli#upgrade",
    async inspect({ launch, signal }) {
      if (!launch?.resolved) return { status: "not_installed" };
      const version = await readVersion(launch, signal);
      return version ? { status: "installed", version } : { status: "installed" };
    },
    async checkForUpdates({ launch, signal }): Promise<ProviderUpdateCheck> {
      if (!launch?.resolved) return { status: "unknown", message: "Hoplite is not installed" };
      if (launch.env.HOPLITE_NO_UPDATE_CHECK === "1")
        return { status: "unknown", message: "HOPLITE_NO_UPDATE_CHECK turns update checks off" };
      const installed = parseRelease((await readVersion(launch, signal)) ?? "");
      if (!installed)
        return { status: "unknown", message: "The installed version is not readable" };
      const latestText = (await latestRelease(signal)).trim();
      const latest = parseRelease(latestText);
      if (!latest) return { status: "unknown", message: `Unrecognized release ${latestText}` };
      return isNewer(latest, installed)
        ? { status: "available", versions: [latestText] }
        : { status: "current" };
    },
  };
}
