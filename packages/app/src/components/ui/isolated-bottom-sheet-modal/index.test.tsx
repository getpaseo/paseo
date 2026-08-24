/**
 * @vitest-environment jsdom
 */
import React, { act, createContext, useContext, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A faithful stand-in for `@gorhom/portal`: it renders *nothing* where it sits and hands its
 * element to a host somewhere else in the tree, which is what makes the real thing lose context.
 * A passthrough fake would keep context and quietly pass every test in this file — which is
 * exactly what happened, and why the menu sheet shipped broken.
 */
const portalStore = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let node: React.ReactNode = null;
  return {
    put(next: React.ReactNode) {
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
    BottomSheetModalProvider: ({ children }: { children?: React.ReactNode }) =>
      React.createElement("div", { "data-bottom-sheet-provider": true }, children),
    BottomSheetModal: React.forwardRef(
      ({ children, stackBehavior }: { children?: React.ReactNode; stackBehavior?: string }, _ref) =>
        React.createElement(
          Portal,
          null,
          React.createElement("div", { "data-stack-behavior": stackBehavior }, children),
        ),
    ),
  };
});

import { IsolatedBottomSheetModal, type ContextBridge } from ".";

/** Renders whatever the portal is currently holding, from its own place in the tree. */
function PortalHostProbe() {
  const node = useSyncExternalStore(portalStore.subscribe, portalStore.read, portalStore.read);
  return <div data-portal-host>{node}</div>;
}

const LabelContext = createContext("unbridged");

function Label() {
  return <div data-label={useContext(LabelContext)} />;
}

describe("IsolatedBottomSheetModal presentation", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    portalStore.reset();
  });

  function stackBehaviors(): (string | null)[] {
    return Array.from(container.querySelectorAll("[data-stack-behavior]")).map((node) =>
      node.getAttribute("data-stack-behavior"),
    );
  }

  it("defaults sibling top-level sheets to push instead of replacing by React ancestry", () => {
    act(() => {
      root.render(
        <>
          <IsolatedBottomSheetModal contextBridge={null}>Settings</IsolatedBottomSheetModal>
          <PortalHostProbe />
        </>,
      );
    });
    expect(stackBehaviors()).toEqual(["push"]);

    act(() => {
      root.render(
        <>
          <IsolatedBottomSheetModal contextBridge={null}>Diagnostic</IsolatedBottomSheetModal>
          <PortalHostProbe />
        </>,
      );
    });
    expect(stackBehaviors()).toEqual(["push"]);
  });

  it("only replaces when the callsite asks for replacement", () => {
    act(() => {
      root.render(
        <>
          <IsolatedBottomSheetModal presentation="replace" contextBridge={null}>
            Selector
          </IsolatedBottomSheetModal>
          <PortalHostProbe />
        </>,
      );
    });

    expect(stackBehaviors()).toEqual(["replace"]);
  });
});

describe("IsolatedBottomSheetModal context bridging", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    portalStore.reset();
  });

  function renderSheet(contextBridge: ContextBridge | null) {
    act(() => {
      root.render(
        <>
          <LabelContext.Provider value="from callsite">
            <IsolatedBottomSheetModal contextBridge={contextBridge}>
              <Label />
            </IsolatedBottomSheetModal>
          </LabelContext.Provider>
          {/* Outside the provider, standing in for the app-root portal host. */}
          <PortalHostProbe />
        </>,
      );
    });
    return container.querySelector("[data-label]")?.getAttribute("data-label");
  }

  it("loses callsite context without a bridge", () => {
    expect(renderSheet(null)).toBe("unbridged");
  });

  it("carries callsite context across the portal when bridged", () => {
    const bridge: ContextBridge = (children) => (
      <LabelContext.Provider value="from callsite">{children}</LabelContext.Provider>
    );
    expect(renderSheet(bridge)).toBe("from callsite");
  });
});
