import { useMemo } from "react";
import {
  resolveFilePreviewRendererGated,
  type FilePreviewRenderer,
} from "@/components/file-pane-render-mode";
import { isPluginPreviewablePath } from "@/plugins/bridge";
import { useBoundedPluginListWait } from "@/plugins/plugin-list-wait";
import { usePlugins } from "@/plugins/queries";

/**
 * Which viewer renders this file, and whether that answer is still settling.
 *
 * `pending` is not the same as "code": resolving to the code view before the
 * plugin list lands mounts CodeMirror and tears it straight back down when a
 * plugin turns out to claim the extension.
 *
 * Its own module rather than a `pane.tsx` export: importing the pane drags in
 * the whole preview UI, and two of those dependencies ship JSX inside plain
 * `.js` files, which vite's import analysis refuses to parse — a test of this
 * hook died at load, before any assertion ran.
 */
export function useFilePreviewRenderer(input: {
  serverId: string | null;
  workspaceRoot: string;
  filePath: string;
  lineStart: number | undefined;
  isTextPreview: boolean;
}): { renderer: FilePreviewRenderer; rendererPending: boolean } {
  const { serverId, workspaceRoot, filePath, lineStart, isTextPreview } = input;
  const { plugins, isLoading } = usePlugins(serverId);
  const previewable = isTextPreview && !lineStart;
  const pluggable = previewable && isPluginPreviewablePath(workspaceRoot, filePath);
  const renderer = useMemo<FilePreviewRenderer>(
    () =>
      resolveFilePreviewRendererGated({
        filePath,
        plugins,
        previewable,
        pluginEligible: pluggable,
      }),
    [filePath, plugins, previewable, pluggable],
  );

  // Bounded, because the file pane is a core path and the plugin list is a
  // separate RPC: a daemon that is slow or never answers must not hold the
  // whole pane on a spinner. Past the deadline the built-in renderer wins, and
  // a plugin answer that lands later just re-renders into it. Keyed on the file
  // so one slow file does not spend the budget for every file after it, and on
  // the host so switching hosts does not either. The workspace is in there
  // because `filePath` may be workspace-relative, so one string is two
  // different files in two checkouts on the same host.
  const rendererPending = useBoundedPluginListWait({
    waiting: isLoading && pluggable,
    key: [serverId ?? "", workspaceRoot, filePath].join("\u0000"),
  });

  return { renderer, rendererPending };
}
