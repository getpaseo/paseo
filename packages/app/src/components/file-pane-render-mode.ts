import type { InstalledPlugin } from "@getpaseo/protocol/plugin/types";

export function isRenderedMarkdownFile(filePath: string): boolean {
  const normalizedPath = filePath.trim().toLowerCase();
  return normalizedPath.endsWith(".md") || normalizedPath.endsWith(".markdown");
}

export interface PluginFilePreview {
  pluginId: string;
  pluginName: string;
  contributionId: string;
  title: string;
  entry: string;
}

export type FilePreviewRenderer =
  | { kind: "markdown" }
  | { kind: "code" }
  | ({ kind: "plugin" } & PluginFilePreview);

/**
 * Every preview a plugin offers for a path, best first. Two plugins claiming the
 * same extension resolve alphabetically by plugin id (docs/plugins.md); the rest
 * of the list is what Settings reports as losing the extension.
 */
export function pluginFilePreviewsForPath(input: {
  filePath: string;
  plugins: readonly InstalledPlugin[];
}): PluginFilePreview[] {
  const path = input.filePath.trim().toLowerCase();
  if (!path) {
    return [];
  }

  const matches: PluginFilePreview[] = [];
  for (const plugin of input.plugins) {
    if (!plugin.enabled || plugin.unavailableReason !== null) {
      continue;
    }
    for (const preview of plugin.manifest.contributes.filePreviews ?? []) {
      if (!preview.extensions.some((extension) => path.endsWith(extension.toLowerCase()))) {
        continue;
      }
      matches.push({
        pluginId: plugin.manifest.id,
        pluginName: plugin.manifest.name,
        contributionId: preview.id,
        title: preview.title,
        entry: preview.entry,
      });
      break;
    }
  }

  return matches.sort((left, right) => left.pluginId.localeCompare(right.pluginId));
}

/** How the file pane should render a path: plugin first, then the built-ins. */
export function resolveFilePreviewRenderer(input: {
  filePath: string;
  plugins: readonly InstalledPlugin[];
}): FilePreviewRenderer {
  const [winner] = pluginFilePreviewsForPath(input);
  if (winner) {
    return { kind: "plugin", ...winner };
  }
  return isRenderedMarkdownFile(input.filePath) ? { kind: "markdown" } : { kind: "code" };
}

export interface PluginFilePreviewConflict {
  extension: string;
  winnerPluginId: string;
  losingPluginIds: string[];
}

/** Extensions more than one enabled plugin claims, for the Settings report. */
export function pluginFilePreviewConflicts(
  plugins: readonly InstalledPlugin[],
): PluginFilePreviewConflict[] {
  const claimsByExtension = new Map<string, string[]>();
  for (const plugin of plugins) {
    if (!plugin.enabled || plugin.unavailableReason !== null) {
      continue;
    }
    for (const preview of plugin.manifest.contributes.filePreviews ?? []) {
      for (const extension of preview.extensions) {
        const normalized = extension.toLowerCase();
        const claims = claimsByExtension.get(normalized) ?? [];
        claims.push(plugin.manifest.id);
        claimsByExtension.set(normalized, claims);
      }
    }
  }

  return [...claimsByExtension.entries()]
    .filter(([, claims]) => claims.length > 1)
    .map(([extension, claims]) => {
      const [winnerPluginId, ...losingPluginIds] = [...claims].sort((left, right) =>
        left.localeCompare(right),
      );
      return { extension, winnerPluginId: winnerPluginId ?? "", losingPluginIds };
    })
    .sort((left, right) => left.extension.localeCompare(right.extension));
}
