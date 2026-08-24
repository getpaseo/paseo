import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => {
  const storage = new Map<string, string>();
  return {
    default: {
      getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        storage.set(key, value);
      }),
      removeItem: vi.fn(async (key: string) => {
        storage.delete(key);
      }),
    },
  };
});

import {
  mountBrowserTabAnnouncer,
  type BrowserTabAnnounceClient,
} from "@/desktop/browser/announce";
import { useBrowserStore } from "@/desktop/browser/store";
import { useSessionStore } from "@/stores/session-store";

const SERVER_ID = "server-1";

interface FakeAnnounceClient {
  client: BrowserTabAnnounceClient;
  announceCount(): number;
}

function createFakeClient(): FakeAnnounceClient {
  let announces = 0;
  return {
    client: {
      announceBrowserTabs: () => {
        announces += 1;
      },
    },
    announceCount: () => announces,
  };
}

function advertiseBrowserMirror(browserMirror: boolean): void {
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

  afterEach(() => {
    vi.useRealTimers();
  });

  it("announces once the daemon advertises the browser mirror", () => {
    const fake = createFakeClient();
    const unmount = mountBrowserTabAnnouncer(SERVER_ID, fake.client);

    vi.advanceTimersByTime(1_000);
    expect(fake.announceCount()).toBe(0);

    advertiseBrowserMirror(true);
    vi.advanceTimersByTime(1_000);
    expect(fake.announceCount()).toBe(1);

    unmount();
  });

  it("stays silent against a daemon that cannot mirror, however its tabs change", () => {
    const fake = createFakeClient();
    const unmount = mountBrowserTabAnnouncer(SERVER_ID, fake.client);
    advertiseBrowserMirror(false);

    useBrowserStore.getState().createBrowser({ initialUrl: "example.com" });
    vi.advanceTimersByTime(1_000);
    expect(fake.announceCount()).toBe(0);

    unmount();
  });

  it("coalesces a burst of local tab changes into one announce", () => {
    const fake = createFakeClient();
    advertiseBrowserMirror(true);
    const unmount = mountBrowserTabAnnouncer(SERVER_ID, fake.client);
    vi.advanceTimersByTime(1_000);
    expect(fake.announceCount()).toBe(1);

    const browserId = useBrowserStore.getState().createBrowser({ initialUrl: "example.com" });
    useBrowserStore.getState().updateBrowser(browserId, { title: "Example" });
    useBrowserStore.getState().updateBrowser(browserId, { isLoading: true });
    expect(fake.announceCount()).toBe(1);

    vi.advanceTimersByTime(1_000);
    expect(fake.announceCount()).toBe(2);

    unmount();
  });

  it("stops announcing after unmount", () => {
    const fake = createFakeClient();
    advertiseBrowserMirror(true);
    const unmount = mountBrowserTabAnnouncer(SERVER_ID, fake.client);
    vi.advanceTimersByTime(1_000);
    unmount();

    useBrowserStore.getState().createBrowser({ initialUrl: "example.com" });
    vi.advanceTimersByTime(1_000);
    expect(fake.announceCount()).toBe(1);
  });
});
