import React, { act, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserMirrorInputSurfaceProps } from "./input-surface.types";
import { BrowserMirrorPane } from "./pane";

const PANE_SIZE = { width: 640.4, height: 480.6 };

const remote = vi.hoisted(() => ({ run: vi.fn() }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: ReactNode }) => children,
  TooltipContent: () => null,
}));

// The menu engine positions itself against real layout; the preset rows are
// what this test drives, so they render as plain buttons.
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => children,
  DropdownMenuTrigger: () => null,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => children,
  DropdownMenuSeparator: () => null,
  DropdownMenuItem: ({ children, onSelect }: { children: ReactNode; onSelect: () => void }) => (
    <button type="button" onClick={onSelect}>
      {children}
    </button>
  ),
}));

vi.mock("expo-image", () => ({ Image: () => null }));

vi.mock("@/runtime/host-runtime", () => ({ useHostRuntimeClient: () => null }));

vi.mock("./use-screencast", () => ({
  useBrowserScreencast: () => ({ uri: null, deviceWidth: 0, deviceHeight: 0, error: null }),
}));

vi.mock("./use-remote-tab", () => ({
  useRemoteBrowserTab: () => ({
    tab: {
      url: "https://a.test/",
      title: "a",
      hostLabel: null,
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
    },
    run: remote.run,
  }),
}));

// onLayout needs a real measurement pass in the browser; report the pane size
// this test expects "Responsive" to send.
vi.mock("./input-surface", () => ({
  BrowserMirrorInputSurface: ({
    children,
    onLayout,
  }: BrowserMirrorInputSurfaceProps): ReactNode => {
    useEffect(() => {
      onLayout({ nativeEvent: { layout: { ...PANE_SIZE, x: 0, y: 0 } } } as Parameters<
        typeof onLayout
      >[0]);
    }, [onLayout]);
    return children;
  },
}));

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
  vi.stubGlobal("Node", dom.window.Node);
  vi.stubGlobal("navigator", dom.window.navigator);

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(<BrowserMirrorPane browserId="b1" serverId="s1" workspaceId="w1" isInteractive />);
  });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container = null;
  remote.run.mockReset();
  vi.unstubAllGlobals();
});

function selectDevice(label: string) {
  const item = [...(container?.querySelectorAll("button") ?? [])].find(
    (button) => button.textContent === label,
  );
  if (!item) {
    throw new Error(`no device preset labelled "${label}"`);
  }
  act(() => item.click());
}

function findDevice(label: string) {
  return [...(container?.querySelectorAll("button") ?? [])].find(
    (button) => button.textContent === label,
  );
}

describe("BrowserMirrorPane device sizes", () => {
  it("resizes the remote tab to the picked preset", () => {
    selectDevice("iPhone 14 · 390×844");

    expect(remote.run).toHaveBeenCalledWith({
      command: "resize",
      args: { browserId: "b1", width: 390, height: 844 },
    });
  });

  it("resizes to the swapped dimensions once the preset is rotated", () => {
    selectDevice("iPhone 14 · 390×844");
    selectDevice("workspace.browser.devices.landscape");

    expect(remote.run).toHaveBeenLastCalledWith({
      command: "resize",
      args: { browserId: "b1", width: 844, height: 390 },
    });
    expect(findDevice("iPhone 14 · 844×390")).toBeDefined();
  });

  it("keeps a preset that is already landscape the way round it is stored", () => {
    selectDevice("Laptop · 1366×768");

    expect(remote.run).toHaveBeenLastCalledWith({
      command: "resize",
      args: { browserId: "b1", width: 1366, height: 768 },
    });

    selectDevice("workspace.browser.devices.landscape");

    expect(remote.run).toHaveBeenLastCalledWith({
      command: "resize",
      args: { browserId: "b1", width: 768, height: 1366 },
    });
  });

  it("sends this viewer's pane size for responsive, which has no remote equivalent", () => {
    selectDevice("workspace.browser.devices.responsive");

    expect(remote.run).toHaveBeenCalledWith({
      command: "resize",
      args: { browserId: "b1", width: 640, height: 481 },
    });
  });

  it("offers no orientation for responsive, which fills whatever it is given", () => {
    selectDevice("iPhone 14 · 390×844");
    selectDevice("workspace.browser.devices.landscape");
    remote.run.mockClear();

    selectDevice("workspace.browser.devices.responsive");

    expect(remote.run).toHaveBeenLastCalledWith({
      command: "resize",
      args: { browserId: "b1", width: 640, height: 481 },
    });
    expect(findDevice("workspace.browser.devices.landscape")).toBeUndefined();
  });
});
