import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { MAX_PROVIDER_ICON_BYTES, providerIconSvgFailure } from "../provider-icon-svg.js";

export async function readPluginProviderIcon(
  pluginDirectory: string,
  iconPath: string,
): Promise<string> {
  const resolvedDirectory = await realpath(path.resolve(pluginDirectory));
  const requestedIcon = path.resolve(resolvedDirectory, iconPath);
  assertInsidePluginDirectory(resolvedDirectory, requestedIcon, iconPath);
  const resolvedIcon = await realpath(requestedIcon).catch(() => null);
  if (!resolvedIcon) {
    throw iconError(iconPath, "file does not exist or is not a regular file");
  }
  assertInsidePluginDirectory(resolvedDirectory, resolvedIcon, iconPath);

  const iconStat = await stat(resolvedIcon);
  if (!iconStat.isFile()) {
    throw iconError(iconPath, "file does not exist or is not a regular file");
  }
  if (iconStat.size > MAX_PROVIDER_ICON_BYTES) throw iconError(iconPath, "file exceeds 64 KiB");

  const svg = await readFile(resolvedIcon, "utf8");
  validateSvg(iconPath, svg);
  return svg;
}

function assertInsidePluginDirectory(
  resolvedDirectory: string,
  resolvedIcon: string,
  iconPath: string,
): void {
  const relative = path.relative(resolvedDirectory, resolvedIcon);
  const escapesDirectory =
    relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  if (escapesDirectory) throw iconError(iconPath, "path leaves the plugin directory");
}

function validateSvg(iconPath: string, svg: string): void {
  const failure = providerIconSvgFailure(svg);
  if (failure !== null) throw iconError(iconPath, failure);
}

function iconError(iconPath: string, reason: string): Error {
  return new Error(`Invalid plugin provider icon "${iconPath}": ${reason}`);
}
