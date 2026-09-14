import { readFileSync } from "node:fs";
import path from "node:path";

export function readDesktopBuildInfo(appPath: string): {
  appName: string;
  autoUpdateEnabled: boolean;
} {
  try {
    const metadata = JSON.parse(readFileSync(path.join(appPath, "package.json"), "utf8")) as {
      paseoLocalBuild?: unknown;
    };
    if (metadata.paseoLocalBuild === true) {
      return { appName: "Paseo Local", autoUpdateEnabled: false };
    }
  } catch {
    // Keep release behavior when package metadata cannot be read.
  }

  return { appName: "Paseo", autoUpdateEnabled: true };
}
