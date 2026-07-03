import { afterEach, describe, expect, it } from "vitest";
import {
  clearResidentBrowserWebviewsForTests,
  ensureResidentBrowserWebview,
  prepareBrowserWebview,
  releaseResidentBrowserWebview,
  removeResidentBrowserWebview,
  takeResidentBrowserWebview,
} from "./browser-webview-resident";

const RESIDENT_HOST_ID = "paseo-browser-resident-webviews";

function residentHost(): HTMLElement {
  const host = document.getElementById(RESIDENT_HOST_ID);
  if (!host) {
    throw new Error("Expected resident browser host");
  }
  return host;
}

function expectPermanentHostParking(host: HTMLElement): void {
  expect(host.style.position).toBe("fixed");
  expect(host.style.left).toBe("0px");
  expect(host.style.top).toBe("0px");
  expect(host.style.width).toBe("1px");
  expect(host.style.height).toBe("1px");
  expect(host.style.overflow).toBe("hidden");
  expect(host.style.opacity).toBe("1");
  expect(host.style.pointerEvents).toBe("none");
  expect(host.style.display).toBe("block");
  expect(host.style.visibility).toBe("visible");
  expect(host.style.transform).toBe("");
}

function expectResidentWebviewParking(webview: HTMLElement): void {
  expect(webview.style.display).toBe("inline-flex");
  expect(webview.style.flex).toBe("0 0 auto");
  expect(webview.style.width).toBe("1280px");
  expect(webview.style.height).toBe("800px");
  expect(webview.style.position).toBe("absolute");
  expect(webview.style.left).toBe("0px");
  expect(webview.style.top).toBe("0px");
  expect(webview.style.zIndex).toBe("0");
}

describe("resident browser webviews", () => {
  afterEach(() => {
    clearResidentBrowserWebviewsForTests();
  });

  it("parks a browser webview in the permanent paintable 1x1 host", () => {
    const visibleHost = document.createElement("div");
    const webview = document.createElement("webview");
    visibleHost.appendChild(webview);
    document.body.appendChild(visibleHost);

    releaseResidentBrowserWebview("browser-a", webview);

    const host = residentHost();
    expect(visibleHost.children).toHaveLength(0);
    expect(Array.from(host.children)).toEqual([webview]);
    expect(webview.isConnected).toBe(true);
    expectPermanentHostParking(host);
    expectResidentWebviewParking(webview);
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
    expectPermanentHostParking(residentHost());
    expectResidentWebviewParking(webview as HTMLElement);
  });

  it("normalizes an existing resident host back to permanent parking", () => {
    const staleHost = document.createElement("div");
    staleHost.id = RESIDENT_HOST_ID;
    staleHost.style.left = "-20000px";
    staleHost.style.width = "1280px";
    staleHost.style.height = "800px";
    staleHost.style.opacity = "0";
    staleHost.style.display = "none";
    document.body.appendChild(staleHost);

    const webview = ensureResidentBrowserWebview({
      browserId: "browser-stale-host",
      url: "https://example.com",
    });

    expect(webview).not.toBeNull();
    expectPermanentHostParking(staleHost);
    expectResidentWebviewParking(webview as HTMLElement);
  });

  it("normalizes an existing resident webview and its stale host before reusing them", () => {
    const staleHost = document.createElement("div");
    staleHost.id = RESIDENT_HOST_ID;
    staleHost.style.left = "-20000px";
    staleHost.style.width = "1280px";
    staleHost.style.height = "800px";
    staleHost.style.opacity = "0";
    staleHost.style.display = "none";

    const staleWebview = document.createElement("webview");
    prepareBrowserWebview(staleWebview, {
      browserId: "browser-stale-child",
      initialUrl: "https://example.com",
    });
    staleWebview.style.display = "none";
    staleWebview.style.width = "1px";
    staleWebview.style.height = "1px";
    staleWebview.style.position = "fixed";
    staleWebview.style.left = "-20000px";
    staleHost.appendChild(staleWebview);
    document.body.appendChild(staleHost);

    const webview = ensureResidentBrowserWebview({
      browserId: "browser-stale-child",
      url: "https://example.com/agent",
    });

    expect(webview).toBe(staleWebview);
    expect(Array.from(staleHost.children)).toEqual([staleWebview]);
    expectPermanentHostParking(staleHost);
    expectResidentWebviewParking(staleWebview);
  });

  it("parks resident webviews as an overlapping stack", () => {
    const firstWebview = ensureResidentBrowserWebview({
      browserId: "browser-first",
      url: "https://example.com/first",
    });
    const secondWebview = ensureResidentBrowserWebview({
      browserId: "browser-second",
      url: "https://example.com/second",
    });

    const host = residentHost();
    expect(firstWebview?.parentElement).toBe(host);
    expect(secondWebview?.parentElement).toBe(host);
    expectResidentWebviewParking(firstWebview as HTMLElement);
    expectResidentWebviewParking(secondWebview as HTMLElement);
  });

  it("moves a resident webview into a visible pane without recreating the node", () => {
    const webview = ensureResidentBrowserWebview({
      browserId: "browser-visible",
      url: "https://example.com",
    });

    const visibleWebview = takeResidentBrowserWebview("browser-visible");

    expect(visibleWebview).toBe(webview);
    expect(webview?.style.position).toBe("");
    expect(webview?.style.left).toBe("");
    expect(webview?.style.top).toBe("");
    expect(webview?.style.zIndex).toBe("");
    expect(takeResidentBrowserWebview("browser-visible")).toBeNull();
  });

  it("returns an existing visible pane webview instead of creating a resident duplicate", () => {
    const visibleHost = document.createElement("div");
    const visibleWebview = document.createElement("webview");
    prepareBrowserWebview(visibleWebview, {
      browserId: "browser-visible-pane",
      initialUrl: "https://example.com",
    });
    visibleHost.appendChild(visibleWebview);
    document.body.appendChild(visibleHost);

    const webview = ensureResidentBrowserWebview({
      browserId: "browser-visible-pane",
      url: "https://example.com/agent",
    });

    expect(webview).toBe(visibleWebview);
    expect(document.getElementById(RESIDENT_HOST_ID)).toBeNull();
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
