/**
 * @vitest-environment jsdom
 */
import React, { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToastApi } from "@/components/toast-host";

/**
 * A faithful stand-in for `@gorhom/portal`: it renders nothing where it sits and hands its
 * element to a host elsewhere in the tree, so the sheet's content loses the composer's context
 * exactly as it does on a phone and on a narrow window.
 */
const portalStore = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let node: unknown = null;
  return {
    put(next: unknown) {
      node = next;
      for (const listener of listeners) listener();
    },
    read: () => node,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reset() {
      node = null;
      listeners.clear();
    },
  };
});

vi.mock("@gorhom/portal", () => ({
  Portal: ({ children }: { children?: React.ReactNode }) => {
    React.useEffect(() => {
      portalStore.put(children);
    }, [children]);
    return null;
  },
  PortalHost: () => React.createElement("div", { "data-host": true }),
}));

vi.mock("@gorhom/bottom-sheet", async () => {
  const { Portal } = await import("@gorhom/portal");
  return {
    BottomSheetHandle: () => null,
    useBottomSheetGestureHandlers: () => ({}),
    BottomSheetModalProvider: ({ children }: { children?: React.ReactNode }) =>
      React.createElement("div", null, children),
    BottomSheetModal: React.forwardRef(({ children }: { children?: React.ReactNode }, _ref) =>
      React.createElement(Portal, null, children),
    ),
  };
});

vi.mock("@/plugins/client-runtime", () => ({
  createPluginClientRuntime: () => ({
    paseo: { dispose: async () => {} },
    rpc: async () => undefined,
    openSurface: () => undefined,
    openPanel: () => undefined,
    addComposerPill: () => ({ update() {}, remove() {} }),
    addHeaderButton: () => ({ update() {}, remove() {} }),
  }),
}));

import appPackage from "../../../package.json";
import { IsolatedBottomSheetModal } from "@/components/ui/isolated-bottom-sheet-modal";
import { ToastApiProvider } from "@/contexts/toast-context";
import { PluginComposerItems } from "@/plugins/composer-items";
import { pluginRegistry } from "@/plugins/registry";
import {
  ComposerAgentProvider,
  ComposerInputProvider,
  type ComposerAgent,
  type ComposerInput,
} from "@/composer/session";
import { useComposerSheetBridge } from "./sheet-bridge";

// One toggle that reads the composer's metadata, as a plugin author writes it.
const PLUGIN_BUNDLE = `(function(require) {
  const React = require("react");
  const { useComposer } = require("@getpaseo/plugin/client");
  const { Toggle } = require("@getpaseo/plugin/client/ui");
  const module = { exports: {} };
  function NeedsReview() {
    const { agent, setMetadata } = useComposer();
    return React.createElement(Toggle, {
      title: "Needs review",
      icon: "Scan",
      value: agent.metadata.needsReview === true,
      onValueChange: ({ value }) => setMetadata({ needsReview: value }),
    });
  }
  module.exports.default = function(plugin) {
    plugin.addComposerItem({ id: "needs-review", Component: NeedsReview });
    return function() {};
  };
  return module.exports;
})`;

const agent: ComposerAgent = {
  context: "draft",
  provider: "claude",
  model: "sonnet",
  mode: null,
  thinking: null,
  options: {},
  metadata: { needsReview: true },
  setProvider: async () => {},
  setModel: async () => {},
  setMode: async () => {},
  setThinking: async () => {},
  setOptions: async () => {},
  setMetadata: async () => {},
};

const input: ComposerInput = {
  textSource: { getSnapshot: () => "", subscribe: () => () => {} },
  setText: () => {},
  insertText: () => {},
  attachments: [],
  changeAttachments: () => {},
};

const toast = { error: () => {} } as unknown as ToastApi;

/** The overflow sheet: the plugin's items inside a sheet, opened from the composer. */
function OverflowSheet() {
  const sheetBridge = useComposerSheetBridge();
  return (
    <IsolatedBottomSheetModal contextBridge={sheetBridge}>
      <PluginComposerItems serverId="host-a" surface="sheet" />
    </IsolatedBottomSheetModal>
  );
}

/** Renders whatever the portal holds from the app root, outside every composer provider. */
function PortalHostProbe() {
  const node = useSyncExternalStore(portalStore.subscribe, portalStore.read, portalStore.read);
  return <div data-portal-host>{node as React.ReactNode}</div>;
}

describe("the composer's overflow sheet", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("React", React);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    pluginRegistry.installCatalog(
      "host-a",
      [
        {
          id: "review",
          clientBundle: PLUGIN_BUNDLE,
          requirements: { paseo: `>=${appPackage.version}` },
        },
      ],
      { client: {} as DaemonClient, audio: { play: async () => 0 } },
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    portalStore.reset();
    pluginRegistry.removeHost("host-a");
  });

  it("draws a plugin's composer item as a row that reads the composer", () => {
    act(() => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <ToastApiProvider api={toast}>
            <ComposerAgentProvider value={agent}>
              <ComposerInputProvider value={input}>
                <OverflowSheet />
              </ComposerInputProvider>
            </ComposerAgentProvider>
          </ToastApiProvider>
          <PortalHostProbe />
        </QueryClientProvider>,
      );
    });

    const sheet = container.querySelector("[data-portal-host]");
    expect(sheet?.textContent).toContain("Needs review");
    // The toggle reads `agent.metadata.needsReview`, so the row shows the composer's value.
    expect(sheet?.textContent).toContain("On");
  });
});
