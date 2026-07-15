import { describe, expect, it, vi } from "vitest";

import { handleBrowserWindowOpenRequest, PendingBrowserWindowOpenRequests } from ".";

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

describe("pending browser window-open requests", () => {
  it("holds early allowed popups until browser identity registration", () => {
    const pending = new PendingBrowserWindowOpenRequests();
    pending.add(101, "https://example.com/first");
    pending.add(101, "file:///etc/passwd");
    pending.add(101, "https://example.com/second");

    expect(pending.take(101)).toEqual(["https://example.com/first", "https://example.com/second"]);
    expect(pending.take(101)).toEqual([]);
  });

  it("drops pending popups when an unregistered guest is destroyed", () => {
    const pending = new PendingBrowserWindowOpenRequests();
    pending.add(202, "https://example.com/target");
    pending.delete(202);

    expect(pending.take(202)).toEqual([]);
  });
});
