import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

const MAX_ICON_BYTES = 64 * 1024;

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
  if (iconStat.size > MAX_ICON_BYTES) throw iconError(iconPath, "file exceeds 64 KiB");

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
  if (!/^\s*<svg(?:\s|>)/i.test(svg)) throw iconError(iconPath, "file is not an SVG document");
  if (/<script(?:\s|>)/i.test(svg)) throw iconError(iconPath, "script elements are not allowed");
  if (/<foreignObject(?:\s|>)/i.test(svg)) {
    throw iconError(iconPath, "foreignObject elements are not allowed");
  }
  if (/<style(?:\s|>)/i.test(svg)) throw iconError(iconPath, "style elements are not allowed");
  if (/\son[a-z0-9_-]*\s*=/i.test(svg)) {
    throw iconError(iconPath, "event-handler attributes are not allowed");
  }
  if (/javascript\s*:/i.test(svg)) throw iconError(iconPath, "javascript URLs are not allowed");

  const hrefPattern = /\s(?:href|xlink:href)\s*=\s*(?:(["'])(.*?)\1|([^\s>]+))/gi;
  for (const match of svg.matchAll(hrefPattern)) {
    const href = match[2] ?? match[3] ?? "";
    if (!href.startsWith("#")) {
      throw iconError(iconPath, "external href references are not allowed");
    }
  }
}

function iconError(iconPath: string, reason: string): Error {
  return new Error(`Invalid plugin provider icon "${iconPath}": ${reason}`);
}
