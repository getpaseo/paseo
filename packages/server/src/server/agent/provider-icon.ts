import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import { MAX_PROVIDER_ICON_BYTES, providerIconSvgFailure } from "../provider-icon-svg.js";
import { resolvePaseoHome } from "../paseo-home.js";

/**
 * Reads and validates the SVG configured as a provider icon. Absolute paths are
 * used as-is; relative paths resolve inside the Paseo home directory.
 */
export function readConfiguredProviderIcon(iconPath: string): string {
  let resolved: string;
  if (path.isAbsolute(iconPath)) {
    resolved = path.resolve(iconPath);
  } else {
    const paseoHome = resolvePaseoHome();
    resolved = path.resolve(paseoHome, iconPath);
    if (!isInside(paseoHome, resolved)) {
      throw configuredIconError(iconPath, "path leaves the Paseo home directory");
    }
  }
  try {
    resolved = realpathSync(resolved);
  } catch {
    throw configuredIconError(iconPath, "file does not exist or is not a regular file");
  }

  const iconStat = statSync(resolved);
  if (!iconStat.isFile()) {
    throw configuredIconError(iconPath, "file does not exist or is not a regular file");
  }
  if (iconStat.size > MAX_PROVIDER_ICON_BYTES) {
    throw configuredIconError(iconPath, "file exceeds 64 KiB");
  }

  const svg = readFileSync(resolved, "utf8");
  const failure = providerIconSvgFailure(svg);
  if (failure !== null) throw configuredIconError(iconPath, failure);
  return svg;
}

function isInside(directory: string, candidate: string): boolean {
  const relative = path.relative(directory, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function configuredIconError(iconPath: string, reason: string): Error {
  return new Error(`Invalid provider icon "${iconPath}": ${reason}`);
}
