import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => {}),
    removeItem: vi.fn(async () => {}),
  },
}));

import { mountBrowserTabAnnouncer } from "@/desktop/browser/announce";
import { useBrowserStore } from "@/desktop/browser/store";
import { useSessionStore } from "@/stores/session-store";

const SERVER_ID = "server-1";

function advertise(browserMirror: boolean): void {
  useSessionStore.getState().updateSessionServerInfo(SERVER_ID, {
    serverId: SERVER_ID,
    hostname: "host",
    version: "0.5.1",
    features: { browserMirror },
  });
}

describe("mountBrowserTabAnnouncer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useBrowserStore.setState({ browsersById: {} });
    useSessionStore.setState({ sessions: {} });
    useSessionStore.getState().initializeSession(SERVER_ID, null, 0);
  });
  afterEach(() => vi.useRealTimers());

  it("waits until the daemon advertises browser mirroring", () => {
    const announceBrowserTabs = vi.fn();
    const unmount = mountBrowserTabAnnouncer(
      SERVER_ID,
      { announceBrowserTabs },
      { debounceMs: 10 },
    );
    vi.advanceTimersByTime(10);
    expect(announceBrowserTabs).not.toHaveBeenCalled();

    advertise(true);
    vi.advanceTimersByTime(10);
    expect(announceBrowserTabs).toHaveBeenCalledOnce();
    unmount();
  });

  it("coalesces local tab changes", () => {
    const announceBrowserTabs = vi.fn();
    advertise(true);
    const unmount = mountBrowserTabAnnouncer(
      SERVER_ID,
      { announceBrowserTabs },
      { debounceMs: 10 },
    );
    const id = useBrowserStore.getState().createBrowser({ initialUrl: "example.com" });
    useBrowserStore.getState().updateBrowser(id, { title: "Example" });
    vi.advanceTimersByTime(10);
    expect(announceBrowserTabs).toHaveBeenCalledOnce();
    unmount();
  });

  it("cancels pending work when unmounted", () => {
    const announceBrowserTabs = vi.fn();
    advertise(true);
    const unmount = mountBrowserTabAnnouncer(SERVER_ID, {
      announceBrowserTabs,
    });
    unmount();
    vi.runAllTimers();
    expect(announceBrowserTabs).not.toHaveBeenCalled();
  });
});
