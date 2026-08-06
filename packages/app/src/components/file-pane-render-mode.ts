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
  const PLUGIN_TITLE_MAX_CHARS = 24;
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
        // ponytail: the title is plugin-authored and lands in a segmented
        // control that does not wrap. Truncate here so every consumer of the
        // render model gets a bounded string.
        title: preview.title.trim().slice(0, PLUGIN_TITLE_MAX_CHARS),
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

/**
 * The file pane's whole renderer decision, minus the query.
 *
 * The two gates are separate on purpose. `previewable` is false for a binary
 * preview or a line target — only the code view can honour a specific line — and
 * turns everything off. `pluginEligible` is narrower: it is false for a file
 * with no workspace-relative path, because there is no path a plugin could be
 * handed. Only the plugin half is gated on it. Collapsing the two took the
 * built-in markdown view away from `~/notes.md`, which it had always rendered.
 */
export function resolveFilePreviewRendererGated(input: {
  filePath: string;
  plugins: readonly InstalledPlugin[];
  previewable: boolean;
  pluginEligible: boolean;
}): FilePreviewRenderer {
  if (!input.previewable) {
    return { kind: "code" };
  }
  return resolveFilePreviewRenderer({
    filePath: input.filePath,
    plugins: input.pluginEligible ? input.plugins : [],
  });
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
  // A set per extension, not a list: a plugin that claims one extension from two
  // of its own previews resolves to itself in the pane, so counting it twice
  // would report it as conflicting with itself.
  const claimsByExtension = new Map<string, Set<string>>();
  for (const plugin of plugins) {
    if (!plugin.enabled || plugin.unavailableReason !== null) {
      continue;
    }
    for (const preview of plugin.manifest.contributes.filePreviews ?? []) {
      for (const extension of preview.extensions) {
        const normalized = extension.toLowerCase();
        const claims = claimsByExtension.get(normalized) ?? new Set<string>();
        claims.add(plugin.manifest.id);
        claimsByExtension.set(normalized, claims);
      }
    }
  }

  return [...claimsByExtension.entries()]
    .filter(([, claims]) => claims.size > 1)
    .map(([extension, claims]) => {
      const [winnerPluginId, ...losingPluginIds] = [...claims].sort((left, right) =>
        left.localeCompare(right),
      );
      return { extension, winnerPluginId: winnerPluginId ?? "", losingPluginIds };
    })
    .sort((left, right) => left.extension.localeCompare(right.extension));
}
