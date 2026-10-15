import { describe, expect, it } from "vitest";
import type { WorkspaceLayout } from "@/stores/workspace-layout-store";
import { createDefaultLayout } from "@/stores/workspace-layout-store";
import { FOCUSED_PANE_PLACEMENT, openTabInLayoutFocused } from "@/stores/workspace-layout-actions";
import {
  resolveBrowserNewTabRequest,
  resolveBrowserNewTabPlacement,
  type BrowserNewTabRequest,
} from ".";

function createLayoutWithBrowser(browserId: string): WorkspaceLayout {
  return openTabInLayoutFocused({
    layout: createDefaultLayout(),
    target: { kind: "browser", browserId },
    now: 1,
    placement: FOCUSED_PANE_PLACEMENT,
    explorerSidebarPaneId: null,
  })!.layout;
}

describe("browser new-tab requests", () => {
  it("accepts desktop requests from browser tabs in the current workspace", () => {
    const request = resolveBrowserNewTabRequest({
      payload: {
        sourceBrowserId: "browser-1",
        url: "https://example.com/target",
      },
      workspaceLayout: createLayoutWithBrowser("browser-1"),
    });

    expect(request).toEqual<BrowserNewTabRequest>({
      sourceBrowserId: "browser-1",
      url: "https://example.com/target",
    });
  });

  it("ignores desktop requests from another workspace", () => {
    const request = resolveBrowserNewTabRequest({
      payload: {
        sourceBrowserId: "browser-from-other-workspace",
        url: "https://example.com/target",
      },
      workspaceLayout: createLayoutWithBrowser("browser-1"),
    });

    expect(request).toBeNull();
  });

  it("rejects unsupported desktop request URLs", () => {
    const request = resolveBrowserNewTabRequest({
      payload: {
        sourceBrowserId: "browser-1",
        url: "file:///etc/passwd",
      },
      workspaceLayout: createLayoutWithBrowser("browser-1"),
    });

    expect(request).toBeNull();
  });
  it("places new tabs after their source and keeps parentage separate from insertion order", () => {
    const layout = createLayoutWithBrowser("browser-1");
    const sourceTabId = layout.root.kind === "pane" ? layout.root.pane.focusedTabId : null;
    const request = resolveBrowserNewTabRequest({
      payload: { sourceBrowserId: "browser-1", url: "https://example.com/child" },
      workspaceLayout: layout,
    });
    expect(request).toEqual({ sourceBrowserId: "browser-1", url: "https://example.com/child" });
    expect(resolveBrowserNewTabPlacement({ request: request!, workspaceLayout: layout })).toEqual({
      placement: { mode: "pane", paneId: "main" },
      insertionPosition: { afterTabId: sourceTabId },
      parentTabId: sourceTabId,
    });
    expect(
      resolveBrowserNewTabPlacement({ request: request!, workspaceLayout: createDefaultLayout() }),
    ).toBeNull();
  });

  it.each(["http://localhost:3000", "https://example.com", "about:blank"])("allows %s", (url) => {
    expect(
      resolveBrowserNewTabRequest({
        payload: { sourceBrowserId: "browser-1", url },
        workspaceLayout: createLayoutWithBrowser("browser-1"),
      }),
    ).toEqual({ sourceBrowserId: "browser-1", url });
  });

  it.each(["javascript:alert(1)", "about:settings", "/relative", "invalid"])(
    "rejects %s",
    (url) => {
      expect(
        resolveBrowserNewTabRequest({
          payload: { sourceBrowserId: "browser-1", url },
          workspaceLayout: createLayoutWithBrowser("browser-1"),
        }),
      ).toBeNull();
    },
  );
});
