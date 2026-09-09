export interface PluginSourceReference {
  source: string;
  pluginPath: string | undefined;
}

export function parsePluginSourceReference(reference: string): PluginSourceReference {
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
  } else {
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
