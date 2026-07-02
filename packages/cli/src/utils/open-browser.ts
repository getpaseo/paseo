import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

interface BrowserOpenCommand {
  command: string;
  args: string[];
}

type BrowserOpenSpawn = (
  command: string,
  args: string[],
  options: { stdio: "ignore"; detached: true },
) => Pick<ChildProcessWithoutNullStreams, "on" | "unref">;

interface BrowserOpenDependencies {
  platform?: NodeJS.Platform;
  spawn?: BrowserOpenSpawn;
}

/**
 * Best-effort cross-platform browser opener for CLI OAuth flows. Returns true if the
 * opener process was spawned, false otherwise. Callers must always print the URL too,
 * so a failed/headless open still lets the user copy it.
 */
export function browserOpenCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): BrowserOpenCommand {
  switch (platform) {
    case "darwin":
      return { command: "open", args: [url] };
    case "win32":
      return { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] };
    default:
      return { command: "xdg-open", args: [url] };
  }
}

export function openBrowserUrl(url: string, dependencies: BrowserOpenDependencies = {}): boolean {
  const spawnBrowser = dependencies.spawn ?? spawn;
  const { command, args } = browserOpenCommand(url, dependencies.platform);

  try {
    const child = spawnBrowser(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
