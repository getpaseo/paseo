import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { app } from "electron";

export interface DesktopBundleSyncInfo {
  displacedBundle: boolean;
  onDiskAppVersion: string | null;
  relaunchExecPath: string | null;
}

const DISPLACED_BUNDLE_SEGMENT_PATTERN =
  /(?:^|\/)\.?[^/]+\.app\.(?:outgoing|incoming)[^/]*(?:\/|$)/i;
const CANONICAL_MAC_BUNDLE_PATTERN =
  /^(.+?)\/(\.?([^/]+?)\.app(?:\.(?:outgoing|incoming)[^/]*)?)\/Contents(?:\/|$)/i;
const DEFAULT_MAC_APP_BUNDLE_PATH = "/Applications/Paseo.app";

export function extractPlistBundleShortVersion(plistContents: string): string | null {
  const match = plistContents.match(
    /<key>\s*CFBundleShortVersionString\s*<\/key>\s*<string>\s*([^<]+?)\s*<\/string>/i,
  );
  const value = match?.[1]?.trim();
  return value && value.length > 0 ? value : null;
}

export function isDisplacedMacBundlePath(targetPath: string): boolean {
  if (!targetPath) return false;
  return DISPLACED_BUNDLE_SEGMENT_PATTERN.test(targetPath.replaceAll("\\", "/"));
}

export function resolveCanonicalMacAppBundlePath(input: {
  execPath: string;
  appPath: string;
}): string | null {
  for (const rawPath of [input.execPath, input.appPath]) {
    if (!rawPath) continue;
    const normalized = rawPath.replaceAll("\\", "/");
    const match = normalized.match(CANONICAL_MAC_BUNDLE_PATTERN);
    if (match) {
      const parentDir = match[1];
      const rawName = match[3] ?? "";
      const appName = rawName.startsWith(".") ? rawName.slice(1) : rawName;
      if (parentDir && appName) {
        return path.posix.join(parentDir, `${appName}.app`);
      }
    }
  }
  return null;
}

function readBundleShortVersion(
  bundlePath: string,
  existsSyncImpl: typeof existsSync,
  readFileSyncImpl: typeof readFileSync,
): string | null {
  const plistPath = path.posix.join(bundlePath, "Contents", "Info.plist");
  if (!existsSyncImpl(plistPath)) return null;
  try {
    const contents = readFileSyncImpl(plistPath, "utf8");
    return extractPlistBundleShortVersion(contents);
  } catch {
    return null;
  }
}

export function inspectDesktopBundleSync(input: {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  execPath: string;
  appPath: string;
  existsSyncImpl?: typeof existsSync;
  readFileSyncImpl?: typeof readFileSync;
}): DesktopBundleSyncInfo {
  if (input.platform !== "darwin" || !input.isPackaged) {
    return {
      displacedBundle: false,
      onDiskAppVersion: null,
      relaunchExecPath: null,
    };
  }

  const existsSyncImpl = input.existsSyncImpl ?? existsSync;
  const readFileSyncImpl = input.readFileSyncImpl ?? readFileSync;

  const canonicalBundlePath = resolveCanonicalMacAppBundlePath({
    execPath: input.execPath,
    appPath: input.appPath,
  });

  const displacedBundle =
    isDisplacedMacBundlePath(input.execPath) ||
    isDisplacedMacBundlePath(input.appPath) ||
    (input.execPath.length > 0 && !existsSyncImpl(input.execPath));

  const candidateBundles = [
    ...(canonicalBundlePath ? [canonicalBundlePath] : []),
    ...(canonicalBundlePath !== DEFAULT_MAC_APP_BUNDLE_PATH ? [DEFAULT_MAC_APP_BUNDLE_PATH] : []),
  ];

  let onDiskAppVersion: string | null = null;
  let relaunchExecPath: string | null = null;

  for (const bundlePath of candidateBundles) {
    if (!onDiskAppVersion) {
      onDiskAppVersion = readBundleShortVersion(bundlePath, existsSyncImpl, readFileSyncImpl);
    }
    if (!relaunchExecPath) {
      const execName = path.posix.basename(input.execPath) || "Paseo";
      const candidateExec = path.posix.join(bundlePath, "Contents", "MacOS", execName);
      if (existsSyncImpl(candidateExec)) {
        relaunchExecPath = candidateExec;
      }
    }
  }

  return {
    displacedBundle,
    onDiskAppVersion,
    relaunchExecPath,
  };
}

export function getDesktopBundleSyncInfo(): DesktopBundleSyncInfo {
  return inspectDesktopBundleSync({
    platform: process.platform,
    isPackaged: app.isPackaged,
    execPath: process.execPath,
    appPath: app.getAppPath(),
  });
}
