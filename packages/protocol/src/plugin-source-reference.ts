import type { PluginInstallation } from "./messages.js";
export interface PluginSourceReference {
  source: string;
  pluginPath: string | undefined;
}

export function parsePluginSourceReference(reference: string): PluginSourceReference {
  const prefix = /^(npm:|github:|git:(?!\/\/))/.exec(reference)?.[0];
  const source = prefix ? reference.slice(prefix.length) : reference;
  const parsed = splitPluginPath(source, { scp: prefix !== "npm:" });
  return { ...parsed, source: `${prefix ?? ""}${parsed.source}` };
}

function splitPluginPath(reference: string, options: { scp: boolean }): PluginSourceReference {
  const separator = reference.lastIndexOf(":");
  if (separator === -1) return { source: reference, pluginPath: undefined };

  const pluginPath = reference.slice(separator + 1);
  if (!isPortableRelativePluginPath(pluginPath)) {
    return { source: reference, pluginPath: undefined };
  }

  const scheme = reference.indexOf("://");
  if (scheme !== -1) {
    const pathStart = reference.indexOf("/", scheme + 3);
    if (pathStart === -1 || separator < pathStart) {
      return { source: reference, pluginPath: undefined };
    }
  } else if (options.scp) {
    const scpSeparator = reference.match(/^[^/@\s]+@[^:\s]+:/)?.[0].length;
    if (scpSeparator !== undefined && separator === scpSeparator - 1) {
      return { source: reference, pluginPath: undefined };
    }
  }

  return { source: reference.slice(0, separator), pluginPath };
}

export function formatPluginSourceReference(
  source: string,
  pluginPath: string | undefined,
): string {
  if (pluginPath === undefined) return source;
  if (!isPortableRelativePluginPath(pluginPath)) {
    throw new Error("Plugin path must be a portable path relative to the repository");
  }
  return `${source}:${pluginPath}`;
}

function isPortableRelativePluginPath(pluginPath: string): boolean {
  if (pluginPath === ".") return true;
  if (!pluginPath || pluginPath.startsWith("/") || pluginPath.startsWith("\\")) return false;
  if (/^[A-Za-z]:/.test(pluginPath) || pluginPath.includes(":")) return false;
  return pluginPath.split(/[\\/]/).every((part) => part !== "" && part !== "." && part !== "..");
}

export function formatPluginIdentity(identity: PluginInstallation["identity"]): string {
  if (identity.kind === "directory") return identity.path;
  const source = identity.kind === "npm" ? `npm:${identity.packageName}` : `git:${identity.remote}`;
  return identity.pluginPath === "." ? source : `${source}:${identity.pluginPath}`;
}
export function formatPluginInstallation(installation: PluginInstallation): string {
  const identity = formatPluginIdentity(installation.identity);
  const revision =
    installation.identity.kind === "git"
      ? installation.currentRevision?.slice(0, 12)
      : installation.currentRevision;
  return revision ? `${identity} · ${revision}` : identity;
}
