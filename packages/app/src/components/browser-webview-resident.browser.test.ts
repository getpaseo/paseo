import { afterEach, describe, expect, it } from "vitest";
import {
  clearResidentBrowserWebviewsForTests,
  ensureResidentBrowserWebview,
  releaseResidentBrowserWebview,
  removeResidentBrowserWebview,
  takeResidentBrowserWebview,
} from "./browser-webview-resident";

describe("resident browser webviews", () => {
  afterEach(() => {
    clearResidentBrowserWebviewsForTests();
  });

  it("keeps a browser webview mounted offscreen and reuses the same node", () => {
    const host = document.createElement("div");
    const webview = document.createElement("webview");
    host.appendChild(webview);
    document.body.appendChild(host);

    releaseResidentBrowserWebview("browser-a", webview);

    expect(host.children).toHaveLength(0);
    expect(webview.isConnected).toBe(true);
    expect(webview.style.width).toBe("1280px");
    expect(webview.style.height).toBe("800px");

    const reused = takeResidentBrowserWebview("browser-a");

    expect(reused).toBe(webview);
    expect(takeResidentBrowserWebview("browser-a")).toBeNull();
  });

  it("creates a resident webview for an agent-created unfocused tab", () => {
    const webview = ensureResidentBrowserWebview({
      browserId: "browser-agent",
      url: "https://example.com",
    });

    expect(webview).not.toBeNull();
    expect(webview?.isConnected).toBe(true);
    expect(webview?.getAttribute("data-paseo-browser-id")).toBe("browser-agent");
    expect(webview?.getAttribute("partition")).toBe("persist:paseo-browser-browser-agent");
    expect((webview as HTMLUnknownElement & { src?: string })?.src).toContain(
      "https://example.com",
    );
  });

  it("removes a resident webview when its browser tab closes", () => {
    const webview = ensureResidentBrowserWebview({
      browserId: "browser-closed",
      url: "https://example.com",
    });

    removeResidentBrowserWebview("browser-closed");

    expect(webview?.isConnected).toBe(false);
    expect(takeResidentBrowserWebview("browser-closed")).toBeNull();
  });
});
