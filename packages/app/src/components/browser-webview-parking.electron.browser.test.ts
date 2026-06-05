import { afterEach, describe, expect, it } from "vitest";
import {
  clearParkedBrowserWebviewsForTests,
  parkBrowserWebview,
  takeParkedBrowserWebview,
} from "./browser-webview-parking.electron";

describe("browser webview parking", () => {
  afterEach(() => {
    clearParkedBrowserWebviewsForTests();
  });

  it("parks a browser webview without destroying it and reuses the same node", () => {
    const host = document.createElement("div");
    const webview = document.createElement("webview");
    host.appendChild(webview);
    document.body.appendChild(host);

    parkBrowserWebview("browser-a", webview);

    expect(host.children).toHaveLength(0);
    expect(webview.isConnected).toBe(true);

    const reused = takeParkedBrowserWebview("browser-a");

    expect(reused).toBe(webview);
    expect(takeParkedBrowserWebview("browser-a")).toBeNull();
  });
});
