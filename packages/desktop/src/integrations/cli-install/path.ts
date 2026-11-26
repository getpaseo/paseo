import path from "node:path";

export function resolveCliInstallSourcePath(input: {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  executablePath: string;
  shimPath: string;
  appImagePath?: string | null;
}): string {
  if (input.platform === "win32") {
    return input.shimPath;
  }

  if (!input.isPackaged) {
    return input.shimPath;
  }

  if (input.platform === "darwin") {
    return input.shimPath;
  }

  if (input.platform === "linux") {
    const appImagePath = input.appImagePath?.trim();
    if (appImagePath) {
      return appImagePath;
    }
    return input.shimPath;
  }

  return input.executablePath;
}

export function resolveCliShimPath(input: {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  executablePath: string;
  resolveWorkspaceCli: () => string;
}): string {
  if (!input.isPackaged) return input.resolveWorkspaceCli();

  if (input.platform === "darwin") {
    const bundle = input.executablePath.replace(/\/Contents\/MacOS\/.+$/, "");
    return path.join(bundle, "Contents", "Resources", "bin", "paseo");
  }
  if (input.platform === "win32") {
    return path.win32.join(
      path.win32.dirname(input.executablePath),
      "resources",
      "bin",
      "paseo.exe",
    );
  }
  return path.join(path.dirname(input.executablePath), "resources", "bin", "paseo");
}

export function cliTargetFileName(platform: NodeJS.Platform, isPackaged: boolean): string {
  if (platform === "win32" && isPackaged) return "paseo.exe";
  if (platform === "win32") return "paseo.cmd";
  return "paseo";
}
