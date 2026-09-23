/**
 * @vitest-environment jsdom
 */
import React, { act, useCallback } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Android delivers Back to the activity, and React Native offers it to `hardwareBackPress`
 * listeners newest-first until one claims it. A sheet that claims nothing lets Back reach the
 * navigator, which pops the route the sheet was covering.
 */
const androidBack = vi.hoisted(() => {
  const listeners: (() => boolean)[] = [];
  return {
    add(listener: () => boolean) {
      listeners.push(listener);
      return {
        remove() {
          const index = listeners.indexOf(listener);
          if (index >= 0) listeners.splice(index, 1);
        },
      };
    },
    /** True when a listener claimed the press; false when it would fall through to the navigator. */
    press(): boolean {
      for (let index = listeners.length - 1; index >= 0; index--) {
        if (listeners[index]?.() === true) return true;
      }
      return false;
    },
    reset() {
      listeners.length = 0;
    },
  };
});

vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  BackHandler: {
    addEventListener: (event: string, listener: () => boolean) =>
      event === "hardwareBackPress" ? androidBack.add(listener) : { remove() {} },
  },
}));

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

/**
 * Stands in for the real sheet's lifecycle: `present()` reports a snap index, `dismiss()` reports
 * index -1 and then dismissal, which is the only signal the wrapper gets about being on screen.
 */
vi.mock("@gorhom/bottom-sheet", async () => {
  const { Portal } = await import("@gorhom/portal");
  interface FakeSheetProps {
    children?: React.ReactNode;
    onChange?: (index: number) => void;
    onDismiss?: () => void;
  }
  return {
    BottomSheetModal: React.forwardRef(function FakeBottomSheetModal(
      props: FakeSheetProps,
      ref: React.Ref<{ present: () => void; dismiss: () => void }>,
    ) {
      const [presented, setPresented] = React.useState(false);
      const { onChange, onDismiss } = props;
      React.useImperativeHandle(
        ref,
        () => ({
          present() {
            setPresented(true);
            onChange?.(0);
          },
          dismiss() {
            setPresented(false);
            onChange?.(-1);
            onDismiss?.();
          },
        }),
        [onChange, onDismiss],
      );
      return React.createElement(
        Portal,
        null,
        React.createElement("div", { "data-presented": presented }, props.children),
      );
    }),
  };
});

import { IsolatedBottomSheetModal, useIsolatedBottomSheetVisibility } from ".";

/** Mirrors how the model selector presents its sheet: visibility hook plus ref, change, dismiss. */
function SheetUnderTest({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { sheetRef, handleSheetChange, handleSheetDismiss } = useIsolatedBottomSheetVisibility({
    visible,
    onClose,
  });
  const noop = useCallback(() => {}, []);
  return (
    <IsolatedBottomSheetModal
      ref={sheetRef}
      contextBridge={null}
      index={0}
      onChange={handleSheetChange}
      onDismiss={handleSheetDismiss}
      onAnimate={noop}
    >
      Models
    </IsolatedBottomSheetModal>
  );
}

function PortalHostProbe() {
  const node = React.useSyncExternalStore(
    portalStore.subscribe,
    portalStore.read,
    portalStore.read,
  );
  return <div data-portal-host>{node}</div>;
}

describe("IsolatedBottomSheetModal Android back", () => {
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
    androidBack.reset();
  });

  function renderSheet(visible: boolean, onClose: () => void) {
    act(() => {
      root.render(
        <>
          <SheetUnderTest visible={visible} onClose={onClose} />
          <PortalHostProbe />
        </>,
      );
    });
  }

  function isPresented(): boolean {
    return container.querySelector("[data-presented='true']") !== null;
  }

  it("claims the Back press while presented and closes the sheet instead of the screen", () => {
    const onClose = vi.fn();
    renderSheet(true, onClose);
    expect(isPresented()).toBe(true);

    let claimed = false;
    act(() => {
      claimed = androidBack.press();
    });

    expect(claimed).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(isPresented()).toBe(false);
  });

  it("leaves Back to the navigator once the sheet is gone", () => {
    const onClose = vi.fn();
    renderSheet(false, onClose);

    let claimed = true;
    act(() => {
      claimed = androidBack.press();
    });

    expect(claimed).toBe(false);
  });

  it("gives the Back press to the sheet presented last", () => {
    const closedFirst = vi.fn();
    const closedLast = vi.fn();
    act(() => {
      root.render(
        <>
          <SheetUnderTest visible onClose={closedFirst} />
          <SheetUnderTest visible onClose={closedLast} />
          <PortalHostProbe />
        </>,
      );
    });

    act(() => {
      androidBack.press();
    });

    expect(closedLast).toHaveBeenCalledTimes(1);
    expect(closedFirst).not.toHaveBeenCalled();
  });
});
