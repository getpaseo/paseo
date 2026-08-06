/**
 * @vitest-environment jsdom
 */
import { useEffect } from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstalledPlugin } from "@getpaseo/protocol/plugin/types";
import type { FilePreviewRenderer } from "@/components/file-pane-render-mode";

// The hook's whole job is to gate on the plugin list, so the list is the one
// thing stubbed. Everything under it — the pure resolver, the containment
// check, the bounded wait — runs for real.
const pluginsState: { plugins: InstalledPlugin[]; isLoading: boolean } = {
  plugins: [],
  isLoading: true,
};
vi.mock("@/plugins/queries", () => ({
  usePlugins: () => ({ ...pluginsState, support: "supported", error: null }),
}));

import { useFilePreviewRenderer } from "./use-file-preview-renderer";

const ROOT = "/home/dev/repo";

function csvPlugin(): InstalledPlugin {
  return {
    manifest: {
      id: "csv-table",
      name: "CSV Table",
      version: "1.0.0",
      contributes: {
        filePreviews: [{ id: "table", title: "Table", extensions: [".csv"], entry: "table.html" }],
      },
    },
    enabled: true,
    installedAt: "2026-02-05T00:00:00.000Z",
    source: { kind: "local" },
    unavailableReason: null,
  };
}

describe("useFilePreviewRenderer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    pluginsState.plugins = [];
    pluginsState.isLoading = true;
  });
  afterEach(() => vi.useRealTimers());

  function render(overrides?: { filePath?: string; isTextPreview?: boolean; lineStart?: number }) {
    // Only what React committed: a render pass it throws away never mounts a
    // viewer, so `result.current` alone cannot tell a held pane from one that
    // flashed the code view for a frame.
    const committed: FilePreviewRenderer[] = [];
    const view = renderHook(() => {
      const state = useFilePreviewRenderer({
        serverId: "host-a",
        workspaceRoot: ROOT,
        filePath: overrides?.filePath ?? `${ROOT}/data.csv`,
        lineStart: overrides?.lineStart,
        isTextPreview: overrides?.isTextPreview ?? true,
      });
      useEffect(() => {
        if (!state.rendererPending) {
          committed.push(state.renderer);
        }
      });
      return state;
    });
    return { ...view, committed };
  }

  it("holds while the plugin list is in flight", () => {
    const { result } = render();

    expect(result.current.rendererPending).toBe(true);
  });

  // A line target and a binary preview can only be served by the code view, so
  // there is nothing a plugin could win and nothing to wait for.
  it("never holds for a file no plugin could claim", () => {
    expect(render({ lineStart: 12 }).result.current.rendererPending).toBe(false);
    expect(render({ isTextPreview: false }).result.current.rendererPending).toBe(false);
    expect(render({ filePath: "/etc/hosts" }).result.current.rendererPending).toBe(false);
  });

  it("gives up on a list that never lands, and takes the built-in view", () => {
    const { result } = render();

    act(() => {
      vi.advanceTimersByTime(2_000);
    });

    expect(result.current.rendererPending).toBe(false);
    expect(result.current.renderer).toEqual({ kind: "code" });
  });

  it("hands the file to a plugin that claims it once the list lands", () => {
    const { result, rerender, committed } = render();
    pluginsState.plugins = [csvPlugin()];
    pluginsState.isLoading = false;

    act(() => {
      rerender();
    });

    expect(result.current.rendererPending).toBe(false);
    expect(result.current.renderer).toMatchObject({ kind: "plugin", pluginId: "csv-table" });
    // The point of the hold: CodeMirror never mounted on the way here.
    expect(committed.map((renderer) => renderer.kind)).toEqual(["plugin"]);
  });
});
