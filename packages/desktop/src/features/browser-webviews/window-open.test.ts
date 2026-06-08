import { describe, expect, it, vi } from "vitest";

import { handleBrowserWindowOpenRequest } from ".";

describe("browser webview window-open requests", () => {
  it("denies Electron window creation and requests a Paseo browser tab", () => {
    const requestNewTab = vi.fn();

    const result = handleBrowserWindowOpenRequest({
      url: "https://example.com/target",
      sourceBrowserId: "browser-1",
      requestNewTab,
    });

    expect(result).toEqual({ action: "deny" });
    expect(requestNewTab).toHaveBeenCalledWith({
      sourceBrowserId: "browser-1",
      url: "https://example.com/target",
    });
  });

  it("denies unsupported window-open requests before asking for a Paseo browser tab", () => {
    const requestNewTab = vi.fn();

    const result = handleBrowserWindowOpenRequest({
      url: "file:///etc/passwd",
      sourceBrowserId: "browser-1",
      requestNewTab,
    });

    expect(result).toEqual({ action: "deny" });
    expect(requestNewTab).not.toHaveBeenCalled();
  });
});
