import { describe, expect, it } from "vitest";
import type { WorkspaceLayout } from "@/stores/workspace-layout-store";
import { createDefaultLayout } from "@/stores/workspace-layout-store";
import { openTabInLayoutFocused } from "@/stores/workspace-layout-actions";
import { resolveBrowserNewTabRequest, type BrowserNewTabRequest } from ".";

function createLayoutWithBrowser(browserId: string): WorkspaceLayout {
  return openTabInLayoutFocused({
    layout: createDefaultLayout(),
    target: { kind: "browser", browserId },
    now: 1,
  }).layout;
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
});
