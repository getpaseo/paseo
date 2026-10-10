import { useNetworkRoutingStatus } from "./network-routing/status";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyInactiveBrowserWebviewViewport,
  type BrowserWebviewProfileHost,
  clearResidentBrowserWebviewsForTests,
  ensureResidentBrowserWebview,
  getResidentBrowserWebview,
  markRemoteProviderReady,
  recreateHostBrowserWebviews,
  reloadFailedHostBrowserWebviews,
  subscribeBrowserWebviewReplacement,
  presentBrowserWebview,
  rememberBrowserWebviewSize,
  releaseResidentBrowserWebview,
  removeResidentBrowserWebview,
  resizeResidentBrowserWebview,
} from "./resident-webviews";
import {
  setCommandCenterFocusRestoreElement,
  takeCommandCenterFocusRestoreElement,
} from "../../utils/command-center-focus-restore";

const RESIDENT_HOST_ID = "paseo-browser-resident-webviews";
const attachedBrowsers: Array<{
  browserId: string;
  workspaceId: string;
  webContentsId: number;
}> = [];
const profileHost: BrowserWebviewProfileHost = {
  profilePartition: "persist:paseo-browser",
  resolvePartition: async () => "persist:paseo-browser",
  registerAttachedBrowser: async (input) => {
    attachedBrowsers.push(input);
  },
};

function ensureTestBrowser(input: {
  browserId: string;
  workspaceId: string;
  url: string;
}): Promise<HTMLElement | null> {
  return ensureResidentBrowserWebview({ ...input, serverId: "server-1", profileHost });
}

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
  expect(host.style.width).toBe("100vw");
  expect(host.style.height).toBe("100vh");
  expect(host.style.overflow).toBe("visible");
  expect(host.style.opacity).toBe("1");
  expect(host.style.pointerEvents).toBe("none");
  expect(host.style.display).toBe("block");
  expect(host.style.zIndex).toBe("0");
}

function expectParkedSurface(surface: HTMLElement): void {
  expect(surface.getAttribute("aria-hidden")).toBe("true");
  expect(surface.style.position).toBe("fixed");
  expect(surface.style.left).toBe("0px");
  expect(surface.style.top).toBe("0px");
  expect(surface.style.width).toBe("1px");
  expect(surface.style.height).toBe("1px");
  expect(surface.style.overflow).toBe("hidden");
  expect(surface.style.opacity).toBe("1");
  expect(surface.style.pointerEvents).toBe("none");
  expect(surface.style.display).toBe("block");
  expect(surface.style.visibility).toBe("visible");
  expect(surface.style.transform).toBe("");
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
  beforeEach(() => {
    attachedBrowsers.length = 0;
  });

  afterEach(() => {
    clearResidentBrowserWebviewsForTests();
  });

  it("parks a browser webview in the permanent paintable 1x1 host", async () => {
    const visibleHost = document.createElement("div");
    const webview = document.createElement("webview");
    visibleHost.appendChild(webview);
    document.body.appendChild(visibleHost);

    releaseResidentBrowserWebview("browser-a", webview);

    const host = residentHost();
    expect(visibleHost.children).toHaveLength(0);
    const surface = host.firstElementChild as HTMLElement;
    expect(Array.from(surface.children)).toEqual([webview]);
    expect(webview.isConnected).toBe(true);
    expectPermanentHostParking(host);
    expectParkedSurface(surface);
    expectResidentWebviewParking(webview);
  });

  it("presents and parks a browser without changing its webview parent", async () => {
    const webview = await ensureTestBrowser({
      browserId: "browser-stable-parent",
      workspaceId: "workspace-stable-parent",
      url: "https://example.com",
    });
    const anchor = document.createElement("div");
    const clip = document.createElement("div");
    Object.defineProperty(anchor, "getBoundingClientRect", {
      value: () => ({ left: 40, top: 60, width: 640, height: 480 }),
    });
    Object.defineProperty(clip, "getBoundingClientRect", {
      value: () => ({ left: 40, top: 60, width: 640, height: 480 }),
    });
    if (!webview?.parentElement) {
      throw new Error("Expected resident browser surface");
    }
    const permanentParent = webview.parentElement;

    presentBrowserWebview("browser-stable-parent", webview, anchor, clip, {
      mode: "responsive",
    });
    expect(webview.parentElement).toBe(permanentParent);
    expect(permanentParent.style.left).toBe("40px");
    expect(permanentParent.style.top).toBe("60px");
    expect(permanentParent.style.width).toBe("640px");
    expect(permanentParent.style.height).toBe("480px");
    expect(permanentParent.style.pointerEvents).toBe("auto");
    expect(permanentParent.getAttribute("aria-hidden")).toBe("false");
    expect(webview.style.flex).toBe("0 0 auto");
    expect(webview.style.width).toBe("640px");
    expect(webview.style.height).toBe("480px");

    releaseResidentBrowserWebview("browser-stable-parent", webview);
    expect(webview.parentElement).toBe(permanentParent);
    expectParkedSurface(permanentParent);

    presentBrowserWebview("browser-stable-parent", webview, anchor, clip, {
      mode: "responsive",
    });
    expect(webview.parentElement).toBe(permanentParent);
  });

  it("clips an oversized fixed viewport to its pane without resizing the webview", async () => {
    const webview = await ensureTestBrowser({
      browserId: "browser-oversized",
      workspaceId: "workspace-oversized",
      url: "https://example.com",
    });
    if (!webview?.parentElement) {
      throw new Error("Expected resident browser surface");
    }
    const anchor = document.createElement("div");
    const clip = document.createElement("div");
    Object.defineProperty(anchor, "getBoundingClientRect", {
      value: () => ({ left: -800, top: -300, width: 2560, height: 1440 }),
    });
    Object.defineProperty(clip, "getBoundingClientRect", {
      value: () => ({ left: 100, top: 150, width: 800, height: 600 }),
    });

    presentBrowserWebview("browser-oversized", webview, anchor, clip, {
      mode: "fixed",
      width: 2560,
      height: 1440,
    });

    expect(webview.parentElement.style.left).toBe("100px");
    expect(webview.parentElement.style.top).toBe("150px");
    expect(webview.parentElement.style.width).toBe("800px");
    expect(webview.parentElement.style.height).toBe("600px");
    expect(webview.style.left).toBe("-900px");
    expect(webview.style.top).toBe("-450px");
    expect(webview.style.width).toBe("2560px");
    expect(webview.style.height).toBe("1440px");

    resizeResidentBrowserWebview({ browserId: "browser-oversized", width: 2560, height: 1440 });

    expect(webview.style.left).toBe("-900px");
    expect(webview.style.top).toBe("-450px");
    expect(webview.parentElement.style.width).toBe("800px");
    expect(webview.parentElement.style.height).toBe("600px");
  });

  it("creates a resident webview for an agent-created unfocused tab", async () => {
    const webview = await ensureTestBrowser({
      browserId: "browser-agent",
      workspaceId: "workspace-agent",
      url: "https://example.com",
    });

    expect(webview).not.toBeNull();
    expect(webview?.isConnected).toBe(true);
    expect(webview?.getAttribute("data-paseo-browser-id")).toBe("browser-agent");
    expect(webview?.getAttribute("partition")).toBe("persist:paseo-browser");
    expect((webview as HTMLUnknownElement & { src?: string })?.src).toContain(
      "https://example.com",
    );
    expectPermanentHostParking(residentHost());
    expectResidentWebviewParking(webview as HTMLElement);
  });

  it("shares one profile and registers attached guests with explicit identity", async () => {
    const firstWebview = await ensureTestBrowser({
      browserId: "browser-first",
      workspaceId: "workspace-a",
      url: "https://example.com/first",
    });
    const secondWebview = await ensureTestBrowser({
      browserId: "browser-second",
      workspaceId: "workspace-b",
      url: "https://example.com/second",
    });
    if (!firstWebview || !secondWebview) {
      throw new Error("Expected resident webviews");
    }
    Object.assign(firstWebview, { getWebContentsId: () => 101 });
    Object.assign(secondWebview, { getWebContentsId: () => 202 });

    firstWebview.dispatchEvent(new Event("did-attach"));
    secondWebview.dispatchEvent(new Event("did-attach"));

    expect(firstWebview.getAttribute("partition")).toBe("persist:paseo-browser");
    expect(secondWebview.getAttribute("partition")).toBe("persist:paseo-browser");
    expect(attachedBrowsers).toEqual([
      { browserId: "browser-first", workspaceId: "workspace-a", webContentsId: 101 },
      { browserId: "browser-second", workspaceId: "workspace-b", webContentsId: 202 },
    ]);
  });

  it("normalizes an existing resident host back to permanent parking", async () => {
    const staleHost = document.createElement("div");
    staleHost.id = RESIDENT_HOST_ID;
    staleHost.style.left = "-20000px";
    staleHost.style.width = "1280px";
    staleHost.style.height = "800px";
    staleHost.style.opacity = "0";
    staleHost.style.display = "none";
    document.body.appendChild(staleHost);

    const webview = await ensureTestBrowser({
      browserId: "browser-stale-host",
      workspaceId: "workspace-stale-host",
      url: "https://example.com",
    });

    expect(webview).not.toBeNull();
    expectPermanentHostParking(staleHost);
    expectResidentWebviewParking(webview as HTMLElement);
  });

  it("normalizes an existing resident webview and its stale host before reusing them", async () => {
    const staleHost = document.createElement("div");
    staleHost.id = RESIDENT_HOST_ID;
    staleHost.style.left = "-20000px";
    staleHost.style.width = "1280px";
    staleHost.style.height = "800px";
    staleHost.style.opacity = "0";
    staleHost.style.display = "none";

    document.body.appendChild(staleHost);
    const staleWebview = (await ensureTestBrowser({
      browserId: "browser-stale-child",
      workspaceId: "workspace-stale-child",
      url: "https://example.com",
    }))!;
    staleWebview.style.display = "none";
    staleWebview.style.width = "1px";
    staleWebview.style.height = "1px";
    staleWebview.style.position = "fixed";
    staleWebview.style.left = "-20000px";
    staleHost.appendChild(staleWebview);
    document.body.appendChild(staleHost);

    const webview = await ensureTestBrowser({
      browserId: "browser-stale-child",
      workspaceId: "workspace-stale-child",
      url: "https://example.com/agent",
    });

    expect(webview).toBe(staleWebview);
    const surface = staleHost.firstElementChild as HTMLElement;
    expect(Array.from(surface.children)).toEqual([staleWebview]);
    expectPermanentHostParking(staleHost);
    expectParkedSurface(surface);
    expectResidentWebviewParking(staleWebview);
  });

  it("parks resident webviews as an overlapping stack", async () => {
    const firstWebview = await ensureTestBrowser({
      browserId: "browser-first",
      workspaceId: "workspace-stack",
      url: "https://example.com/first",
    });
    const secondWebview = await ensureTestBrowser({
      browserId: "browser-second",
      workspaceId: "workspace-stack",
      url: "https://example.com/second",
    });

    const host = residentHost();
    expect(firstWebview?.parentElement?.parentElement).toBe(host);
    expect(secondWebview?.parentElement?.parentElement).toBe(host);
    expect(firstWebview?.parentElement).not.toBe(secondWebview?.parentElement);
    expectResidentWebviewParking(firstWebview as HTMLElement);
    expectResidentWebviewParking(secondWebview as HTMLElement);
  });

  it("returns a resident webview without detaching it from its permanent surface", async () => {
    const webview = await ensureTestBrowser({
      browserId: "browser-visible",
      workspaceId: "workspace-visible",
      url: "https://example.com",
    });

    const permanentParent = webview?.parentElement;
    const visibleWebview = getResidentBrowserWebview("browser-visible");

    expect(visibleWebview).toBe(webview);
    expect(webview?.parentElement).toBe(permanentParent);
    expect(getResidentBrowserWebview("browser-visible")).toBe(webview);
  });

  it("applies an exact fixed viewport without a flex width override", async () => {
    const webview = document.createElement("webview");
    const anchor = document.createElement("div");
    const clip = document.createElement("div");
    Object.defineProperty(anchor, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, width: 640, height: 480 }),
    });
    Object.defineProperty(clip, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, width: 640, height: 480 }),
    });

    presentBrowserWebview("browser-fixed", webview, anchor, clip, {
      mode: "fixed",
      width: 640,
      height: 480,
    });

    expect(webview.style.flex).toBe("0 0 auto");
    expect(webview.style.width).toBe("640px");
    expect(webview.style.height).toBe("480px");
  });

  it("parks a browser at its last resolved viewport dimensions", async () => {
    const visibleHost = document.createElement("div");
    const webview = document.createElement("webview");
    visibleHost.appendChild(webview);
    document.body.appendChild(visibleHost);
    rememberBrowserWebviewSize({ browserId: "browser-sized", width: 640, height: 480 });

    releaseResidentBrowserWebview("browser-sized", webview);

    expect(webview.style.width).toBe("640px");
    expect(webview.style.height).toBe("480px");
  });

  it("keeps an inactive in-place browser at its last resolved viewport dimensions", async () => {
    const webview = document.createElement("webview");
    rememberBrowserWebviewSize({ browserId: "browser-inactive", width: 640, height: 480 });

    applyInactiveBrowserWebviewViewport("browser-inactive", webview, { mode: "responsive" });

    expect(webview.style.flex).toBe("0 0 auto");
    expect(webview.style.width).toBe("640px");
    expect(webview.style.height).toBe("480px");
  });

  it("parks a cold inactive browser at its canonical fixed viewport", async () => {
    const webview = document.createElement("webview");

    applyInactiveBrowserWebviewViewport("browser-restored-fixed", webview, {
      mode: "fixed",
      width: 800,
      height: 600,
    });

    expect(webview.style.width).toBe("800px");
    expect(webview.style.height).toBe("600px");
  });

  it("returns an existing visible pane webview instead of creating a resident duplicate", async () => {
    const visibleHost = document.createElement("div");
    const visibleWebview = (await ensureTestBrowser({
      browserId: "browser-visible-pane",
      workspaceId: "workspace-visible-pane",
      url: "https://example.com",
    }))!;
    visibleHost.appendChild(visibleWebview);
    document.body.appendChild(visibleHost);

    const webview = await ensureTestBrowser({
      browserId: "browser-visible-pane",
      workspaceId: "workspace-visible-pane",
      url: "https://example.com/agent",
    });

    expect(webview).toBe(visibleWebview);
    expect(
      document.querySelectorAll('[data-paseo-browser-id="browser-visible-pane"]'),
    ).toHaveLength(1);
  });

  it("finds the originating browser webview for focus restoration", async () => {
    const webview = await ensureTestBrowser({
      browserId: "browser-focus",
      workspaceId: "workspace-focus",
      url: "https://example.com",
    });

    setCommandCenterFocusRestoreElement(getResidentBrowserWebview("browser-focus"));

    expect(takeCommandCenterFocusRestoreElement()).toBe(webview);

    expect(getResidentBrowserWebview("browser-missing")).toBeNull();
  });

  it("removes a resident webview when its browser tab closes", async () => {
    const webview = await ensureTestBrowser({
      browserId: "browser-closed",
      workspaceId: "workspace-closed",
      url: "https://example.com",
    });

    removeResidentBrowserWebview("browser-closed");

    expect(webview?.isConnected).toBe(false);
    expect(getResidentBrowserWebview("browser-closed")).toBeNull();
  });
});

describe("host browser partitions", () => {
  afterEach(() => clearResidentBrowserWebviewsForTests());
  it("loads the latest URL asked for while the host session is prepared", async () => {
    let ready!: (partition: string) => void;
    const partition = new Promise<string>((resolve) => {
      ready = resolve;
    });
    const host = { ...profileHost, resolvePartition: () => partition };
    const input = {
      browserId: "navigate-while-preparing",
      serverId: "remote",
      workspaceId: "workspace",
      profileHost: host,
    };
    const first = ensureResidentBrowserWebview({ ...input, url: "http://localhost:3000/old" });
    const second = ensureResidentBrowserWebview({ ...input, url: "http://localhost:3000/new" });
    ready("persist:paseo-browser-via-remote");
    const [firstWebview, secondWebview] = await Promise.all([first, second]);
    expect(secondWebview).toBe(firstWebview);
    expect((secondWebview as HTMLElement & { src: string }).src).toBe("http://localhost:3000/new");
  });
  it("waits for the host session and never creates a webview on preparation failure", async () => {
    let ready!: (partition: string) => void;
    const partition = new Promise<string>((resolve) => {
      ready = resolve;
    });
    const host = { ...profileHost, resolvePartition: () => partition };
    const pending = ensureResidentBrowserWebview({
      browserId: "wait-for-host",
      serverId: "remote",
      workspaceId: "workspace",
      url: "http://localhost:3000",
      profileHost: host,
    });
    expect(getResidentBrowserWebview("wait-for-host")).toBeNull();
    ready("persist:paseo-browser-via-remote");
    const webview = await pending;
    expect(webview?.getAttribute("partition")).toBe("persist:paseo-browser-via-remote");
    const failedHost = {
      ...profileHost,
      resolvePartition: async () => {
        throw new Error("not_ready");
      },
    };
    await expect(
      ensureResidentBrowserWebview({
        browserId: "failed-host",
        serverId: "remote",
        workspaceId: "workspace",
        url: "http://localhost:3000",
        profileHost: failedHost,
      }),
    ).rejects.toThrow("not_ready");
    expect(getResidentBrowserWebview("failed-host")).toBeNull();
  });
  it("recreates only the changed host, preserving the current URL, and can switch back", async () => {
    let partition = "persist:paseo-browser";
    const host = { ...profileHost, resolvePartition: async () => partition };
    const first = await ensureResidentBrowserWebview({
      browserId: "switch-host",
      serverId: "remote",
      workspaceId: "workspace",
      url: "http://intranet",
      profileHost: host,
    });
    const other = await ensureResidentBrowserWebview({
      browserId: "other-host",
      serverId: "other",
      workspaceId: "workspace",
      url: "https://example.com",
      profileHost,
    });
    Object.assign(first!, { getURL: () => "http://intranet/current" });
    partition = "persist:paseo-browser-via-remote";
    const changing = recreateHostBrowserWebviews("remote", true);
    expect(first?.isConnected).toBe(false);
    await changing;
    const next = getResidentBrowserWebview("switch-host");
    expect(next).not.toBe(first);
    expect(next?.getAttribute("partition")).toBe(partition);
    expect((next as HTMLElement & { src: string }).src).toBe("http://intranet/current");
    expect(getResidentBrowserWebview("other-host")).toBe(other);
    await recreateHostBrowserWebviews("remote", true);
    expect(getResidentBrowserWebview("switch-host")).toBe(next);
    partition = "persist:paseo-browser";
    await recreateHostBrowserWebviews("remote", false);
    expect(next?.isConnected).toBe(false);
    expect(getResidentBrowserWebview("switch-host")?.getAttribute("partition")).toBe(partition);
  });
  it("does not resurrect a tab closed while its partition was resolving", async () => {
    let ready!: (partition: string) => void;
    const partition = new Promise<string>((resolve) => {
      ready = resolve;
    });
    const pending = ensureResidentBrowserWebview({
      browserId: "closed-pending",
      serverId: "remote",
      workspaceId: "workspace",
      url: "http://intranet",
      profileHost: { ...profileHost, resolvePartition: () => partition },
    });
    removeResidentBrowserWebview("closed-pending");
    ready("persist:paseo-browser-via-remote");
    expect(await pending).toBeNull();
    expect(getResidentBrowserWebview("closed-pending")).toBeNull();
  });

  // Electron clears the guest id on detach and throws from getWebContentsId() until the
  // next attach completes; a listener that throws surfaces as an uncaught window error.
  const NOT_ATTACHED = new Error(
    "The WebView must be attached to the DOM and the dom-ready event emitted before this method can be called.",
  );
  function recordUncaughtErrors(): { errors: Error[]; stop: () => void } {
    const errors: Error[] = [];
    const listener = (event: ErrorEvent) => {
      errors.push(event.error);
      event.preventDefault();
    };
    window.addEventListener("error", listener);
    return { errors, stop: () => window.removeEventListener("error", listener) };
  }

  it("ignores a late did-attach from the webview a routing change retired", async () => {
    let partition = "persist:paseo-browser";
    const attached: number[] = [];
    const host = {
      ...profileHost,
      resolvePartition: async () => partition,
      registerAttachedBrowser: async (input: { webContentsId: number }) => {
        attached.push(input.webContentsId);
      },
    };
    const previous = (await ensureResidentBrowserWebview({
      browserId: "late-attach",
      serverId: "remote",
      workspaceId: "workspace",
      url: "http://intranet",
      profileHost: host,
    }))!;
    Object.assign(previous, { getWebContentsId: () => 1 });
    partition = "persist:paseo-browser-via-remote";
    await recreateHostBrowserWebviews("remote", true);
    const next = getResidentBrowserWebview("late-attach")!;
    expect(next).not.toBe(previous);
    const uncaught = recordUncaughtErrors();
    try {
      previous.dispatchEvent(new Event("did-attach"));
      Object.assign(previous, {
        getWebContentsId: () => {
          throw NOT_ATTACHED;
        },
      });
      previous.dispatchEvent(new Event("did-attach"));
      previous.dispatchEvent(new Event("dom-ready"));
      Object.assign(next, { getWebContentsId: () => 2 });
      next.dispatchEvent(new Event("did-attach"));
    } finally {
      uncaught.stop();
    }
    expect(uncaught.errors).toEqual([]);
    expect(attached).toEqual([2]);
  });

  it("registers on dom-ready when did-attach outruns the guest id", async () => {
    const attached: number[] = [];
    const host = {
      ...profileHost,
      registerAttachedBrowser: async (input: { webContentsId: number }) => {
        attached.push(input.webContentsId);
      },
    };
    const webview = (await ensureResidentBrowserWebview({
      browserId: "early-attach",
      serverId: "remote",
      workspaceId: "workspace",
      url: "http://intranet",
      profileHost: host,
    }))!;
    Object.assign(webview, {
      getWebContentsId: () => {
        throw NOT_ATTACHED;
      },
    });
    const uncaught = recordUncaughtErrors();
    try {
      webview.dispatchEvent(new Event("did-attach"));
      webview.dispatchEvent(new Event("did-attach"));
      expect(attached).toEqual([]);
      Object.assign(webview, { getWebContentsId: () => 7 });
      webview.dispatchEvent(new Event("dom-ready"));
      webview.dispatchEvent(new Event("dom-ready"));
    } finally {
      uncaught.stop();
    }
    expect(uncaught.errors).toEqual([]);
    expect(attached).toEqual([7]);
  });

  it("rethrows an unexpected getWebContentsId failure instead of treating it as not ready", async () => {
    const attached: number[] = [];
    const host = {
      ...profileHost,
      registerAttachedBrowser: async (input: { webContentsId: number }) => {
        attached.push(input.webContentsId);
      },
    };
    const webview = (await ensureResidentBrowserWebview({
      browserId: "unexpected-failure",
      serverId: "remote",
      workspaceId: "workspace",
      url: "http://intranet",
      profileHost: host,
    }))!;
    Object.assign(webview, {
      getWebContentsId: () => {
        throw new Error("unexpected guest lookup failure");
      },
    });
    const uncaught = recordUncaughtErrors();
    try {
      webview.dispatchEvent(new Event("did-attach"));
    } finally {
      uncaught.stop();
    }
    expect(uncaught.errors.map((error) => error.message)).toEqual([
      "unexpected guest lookup failure",
    ]);
    expect(attached).toEqual([]);
  });

  it("registers once when a second did-attach lands before the dom-ready fallback", async () => {
    const attached: number[] = [];
    const host = {
      ...profileHost,
      registerAttachedBrowser: async (input: { webContentsId: number }) => {
        attached.push(input.webContentsId);
      },
    };
    const webview = (await ensureResidentBrowserWebview({
      browserId: "second-attach",
      serverId: "remote",
      workspaceId: "workspace",
      url: "http://intranet",
      profileHost: host,
    }))!;
    Object.assign(webview, {
      getWebContentsId: () => {
        throw NOT_ATTACHED;
      },
    });
    const uncaught = recordUncaughtErrors();
    try {
      webview.dispatchEvent(new Event("did-attach"));
      Object.assign(webview, { getWebContentsId: () => 9 });
      webview.dispatchEvent(new Event("did-attach"));
      webview.dispatchEvent(new Event("dom-ready"));
    } finally {
      uncaught.stop();
    }
    expect(uncaught.errors).toEqual([]);
    expect(attached).toEqual([9]);
  });

  it("drops the previous guest's fallback when the app moves the webview", async () => {
    const attached: number[] = [];
    const host = {
      ...profileHost,
      registerAttachedBrowser: async (input: { webContentsId: number }) => {
        attached.push(input.webContentsId);
      },
    };
    const webview = (await ensureResidentBrowserWebview({
      browserId: "moved-tab",
      serverId: "remote",
      workspaceId: "workspace",
      url: "http://intranet",
      profileHost: host,
    }))!;
    Object.assign(webview, {
      getWebContentsId: () => {
        throw NOT_ATTACHED;
      },
    });
    const elsewhere = document.createElement("div");
    document.body.appendChild(elsewhere);
    const uncaught = recordUncaughtErrors();
    try {
      // 1. The previous guest's did-attach arrives before its id: a fallback is pending.
      webview.dispatchEvent(new Event("did-attach"));
      // 2. The app moves the webview back to its surface, which swaps the guest; the next
      //    guest's id is readable before its own did-attach.
      elsewhere.appendChild(webview);
      releaseResidentBrowserWebview("moved-tab", webview);
      Object.assign(webview, { getWebContentsId: () => 10 });
      // 3. A late dom-ready from the previous guest must not register the next one.
      webview.dispatchEvent(new Event("dom-ready"));
      expect(attached).toEqual([]);
      // 4. The next guest registers through its own did-attach.
      webview.dispatchEvent(new Event("did-attach"));
    } finally {
      uncaught.stop();
      elsewhere.remove();
    }
    expect(uncaught.errors).toEqual([]);
    expect(attached).toEqual([10]);
  });
});

it("recreates a resident tab from the desktop routing event and restores its URL", async () => {
  const originalBridge = window.paseoDesktop;
  const listeners = new Map<string, (payload: unknown) => void>();
  let enabled = false;
  window.paseoDesktop = {
    browser: {
      profilePartition: profileHost.profilePartition,
      registerAttachedBrowser: profileHost.registerAttachedBrowser,
    },
    invoke: async (command) => {
      expect(command).toBe("browser_routing_resolve_partition");
      if (enabled) return { ok: true, partition: "persist:paseo-browser-via-remote" };
      return { ok: false, error: { code: "routing_disabled", message: "disabled" } };
    },
    events: {
      on: (event, callback) => {
        listeners.set(event, callback);
        return () => {
          listeners.delete(event);
        };
      },
    },
  };
  try {
    const initial = await ensureResidentBrowserWebview({
      browserId: "event-tab",
      serverId: "remote",
      workspaceId: "workspace",
      url: "http://intranet",
    });
    expect(initial?.getAttribute("partition")).toBe("persist:paseo-browser");
    Object.assign(initial!, { getURL: () => "http://intranet/current" });
    let replaced!: () => void;
    const replacement = new Promise<void>((resolve) => {
      replaced = resolve;
    });
    const unsubscribe = subscribeBrowserWebviewReplacement("event-tab", replaced);
    enabled = true;
    listeners.get("browser_routing_changed")!({ payload: { serverId: "remote", enabled: true } });
    await replacement;
    const next = getResidentBrowserWebview("event-tab");
    expect(initial?.isConnected).toBe(false);
    expect(next?.getAttribute("partition")).toBe("persist:paseo-browser-via-remote");
    expect((next as HTMLElement & { src: string }).src).toBe("http://intranet/current");
    unsubscribe();
    removeResidentBrowserWebview("event-tab");
    await Promise.resolve();
    expect(listeners.size).toBe(0);
  } finally {
    clearResidentBrowserWebviewsForTests();
    window.paseoDesktop = originalBridge;
  }
});

it("cannot reattach the previous profile while the replacement is preparing", async () => {
  let partition = Promise.resolve("persist:paseo-browser");
  const profile = { ...profileHost, resolvePartition: () => partition };
  const input = {
    browserId: "retired-tab",
    serverId: "remote",
    workspaceId: "workspace",
    url: "http://localhost",
    profileHost: profile,
  };
  try {
    const initial = (await ensureResidentBrowserWebview(input))!;
    let ready!: (partition: string) => void;
    partition = new Promise((resolve) => {
      ready = resolve;
    });
    const changing = recreateHostBrowserWebviews("remote", true);
    // A retained pane can receive ResizeObserver or cleanup callbacks during preparation.
    releaseResidentBrowserWebview(input.browserId, initial);
    presentBrowserWebview(input.browserId, initial, document.body, document.body, {
      mode: "responsive",
    });
    expect(initial.isConnected).toBe(false);
    expect(getResidentBrowserWebview(input.browserId)).toBeNull();
    ready("persist:paseo-browser-via-remote");
    await changing;
    expect(getResidentBrowserWebview(input.browserId)?.getAttribute("partition")).toBe(
      "persist:paseo-browser-via-remote",
    );
  } finally {
    clearResidentBrowserWebviewsForTests();
  }
});

describe("failed navigation recovery after provider registration", () => {
  beforeEach(() => useNetworkRoutingStatus.setState({ hosts: {} }));
  afterEach(() => {
    clearResidentBrowserWebviewsForTests();
    useNetworkRoutingStatus.setState({ hosts: {} });
  });
  async function routedTab(browserId: string, serverId = "remote", routed = true) {
    const webview = (await ensureResidentBrowserWebview({
      browserId,
      serverId,
      workspaceId: "workspace",
      url: "http://intranet",
      profileHost: {
        ...profileHost,
        resolvePartition: async () =>
          routed ? "persist:paseo-browser-via-remote" : "persist:paseo-browser",
      },
    }))!;
    const reload = vi.fn();
    Object.assign(webview, { reload });
    return { webview, reload };
  }
  function fail(
    webview: HTMLElement,
    details: { errorCode: number } | { httpResponseCode: number },
  ) {
    const event = new Event("errorCode" in details ? "did-fail-load" : "did-navigate");
    Object.assign(event, details);
    webview.dispatchEvent(event);
  }
  it.each([{ errorCode: -111 }, { httpResponseCode: 503 }])(
    "reloads only failed routed tabs of the registered host (%j)",
    async (failure) => {
      const failed = await routedTab("failed");
      const healthy = await routedTab("healthy");
      const other = await routedTab("other", "other");
      const shared = await routedTab("shared", "remote", false);
      fail(failed.webview, failure);
      fail(other.webview, failure);
      fail(shared.webview, failure);
      expect(failed.reload).not.toHaveBeenCalled();
      useNetworkRoutingStatus.getState().setStatus("remote", "ready");
      reloadFailedHostBrowserWebviews("remote");
      await Promise.resolve();
      expect(failed.reload).toHaveBeenCalledOnce();
      expect(healthy.reload).not.toHaveBeenCalled();
      expect(other.reload).not.toHaveBeenCalled();
      expect(shared.reload).not.toHaveBeenCalled();
      reloadFailedHostBrowserWebviews("remote");
      fail(failed.webview, failure);
      await Promise.resolve();
      expect(failed.reload).toHaveBeenCalledOnce();
      useNetworkRoutingStatus.getState().setStatus("remote", "ready");
      reloadFailedHostBrowserWebviews("remote");
      await Promise.resolve();
      expect(failed.reload).toHaveBeenCalledTimes(2);
    },
  );
  it("reloads failed routed tabs when another window registers the provider", async () => {
    const tab = await routedTab("remote-owner");
    fail(tab.webview, { errorCode: -111 });
    // This window waits for another one (`provider_exists`), so its own status is not ready.
    useNetworkRoutingStatus.getState().setStatus("remote", "idle");
    reloadFailedHostBrowserWebviews("remote");
    await Promise.resolve();
    expect(tab.reload).not.toHaveBeenCalled();
    markRemoteProviderReady("remote");
    await Promise.resolve();
    expect(tab.reload).toHaveBeenCalledOnce();
    fail(tab.webview, { errorCode: -111 });
    await Promise.resolve();
    expect(tab.reload).toHaveBeenCalledOnce();
    markRemoteProviderReady("remote");
    await Promise.resolve();
    expect(tab.reload).toHaveBeenCalledTimes(2);
  });
  it("recovers a late 503 after registration but never loops within the same registration", async () => {
    const tab = await routedTab("late");
    useNetworkRoutingStatus.getState().setStatus("remote", "ready");
    reloadFailedHostBrowserWebviews("remote");
    await Promise.resolve();
    expect(tab.reload).not.toHaveBeenCalled();
    fail(tab.webview, { httpResponseCode: 503 });
    await Promise.resolve();
    expect(tab.reload).toHaveBeenCalledOnce();
    fail(tab.webview, { httpResponseCode: 503 });
    await Promise.resolve();
    expect(tab.reload).toHaveBeenCalledOnce();
  });
  it("can create a tab on a second attempt after partition preparation fails", async () => {
    const resolvePartition = vi
      .fn()
      .mockRejectedValueOnce(new Error("not_ready"))
      .mockResolvedValue("persist:paseo-browser-via-remote");
    const input = {
      browserId: "retry-attach",
      serverId: "remote",
      workspaceId: "workspace",
      url: "http://intranet/new",
      profileHost: { ...profileHost, resolvePartition },
    };
    await expect(ensureResidentBrowserWebview(input)).rejects.toThrow("not_ready");
    const webview = await ensureResidentBrowserWebview(input);
    expect((webview as HTMLElement & { src: string }).src).toBe(input.url);
    expect(resolvePartition).toHaveBeenCalledTimes(2);
  });
});
