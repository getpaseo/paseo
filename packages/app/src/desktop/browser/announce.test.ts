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

import type { ConnectionState } from "@getpaseo/client/internal/daemon-client";
import {
  mountBrowserTabAnnouncer,
  type BrowserTabAnnounceClient,
} from "@/desktop/browser/announce";
import { useBrowserStore } from "@/desktop/browser/store";

interface FakeAnnounceClient {
  client: BrowserTabAnnounceClient;
  announceCount(): number;
  setConnectionState(state: ConnectionState): void;
}

function createFakeClient(initialState: ConnectionState): FakeAnnounceClient {
  const listeners = new Set<(state: ConnectionState) => void>();
  let connectionState = initialState;
  let announces = 0;

  return {
    client: {
      announceBrowserTabs: () => {
        announces += 1;
      },
      subscribeConnectionStatus: (listener) => {
        listeners.add(listener);
        listener(connectionState);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    announceCount: () => announces,
    setConnectionState: (state) => {
      connectionState = state;
      for (const listener of listeners) {
        listener(state);
      }
    },
  };
}

describe("mountBrowserTabAnnouncer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useBrowserStore.setState({ browsersById: {} });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("announces once the client is connected", () => {
    const fake = createFakeClient({ status: "connecting", attempt: 1 });
    const unmount = mountBrowserTabAnnouncer(fake.client);

    vi.advanceTimersByTime(1_000);
    expect(fake.announceCount()).toBe(0);

    fake.setConnectionState({ status: "connected" });
    vi.advanceTimersByTime(1_000);
    expect(fake.announceCount()).toBe(1);

    unmount();
  });

  it("coalesces a burst of local tab changes into one announce", () => {
    const fake = createFakeClient({ status: "connected" });
    const unmount = mountBrowserTabAnnouncer(fake.client);
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
    const fake = createFakeClient({ status: "connected" });
    const unmount = mountBrowserTabAnnouncer(fake.client);
    vi.advanceTimersByTime(1_000);
    unmount();

    useBrowserStore.getState().createBrowser({ initialUrl: "example.com" });
    vi.advanceTimersByTime(1_000);
    expect(fake.announceCount()).toBe(1);
  });
});
