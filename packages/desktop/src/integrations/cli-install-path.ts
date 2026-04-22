export function resolveCliInstallSourcePath(input: {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  executablePath: string;
  shimPath: string;
  appImagePath?: string | null;
}): string {
  if (!input.isPackaged) {
    return input.shimPath;
  }

  return input.executablePath;
}
