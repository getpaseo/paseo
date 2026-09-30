import React, {
  act,
  useCallback,
  useMemo,
  useState,
  type ReactNode,
  type RefCallback,
} from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { Pressable, Text, View } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MenuOverlay } from "@/components/ui/menu/menu-overlay";
import {
  getOverlayRoot,
  useGlobalWebOverlayLayer,
  useWebOverlayRegistration,
} from "@/lib/overlay-root";
import { Overlay } from "./overlay";

// App sources compile against the classic JSX runtime, which expects React on the global.
beforeEach(() => vi.stubGlobal("React", React));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  document.body.replaceChildren();
  root = null;
  container = null;
});

function mount(node: ReactNode): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

async function frames(count = 2): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  }
}

function byTestId(testID: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="${testID}"]`);
}

function pressEscape(): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
}

function click(testID: string): void {
  act(() => byTestId(testID)?.click());
}

/** A plugin box that can open a confirmation overlay and a host menu from inside itself. */
function PluginBox({ onClosed }: { onClosed: () => void }) {
  const [open, setOpen] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [menu, setMenu] = useState(false);
  const close = useCallback(() => {
    setOpen(false);
    onClosed();
  }, [onClosed]);
  const openConfirm = useCallback(() => setConfirming(true), []);
  const closeConfirm = useCallback(() => setConfirming(false), []);
  const openMenu = useCallback(() => setMenu(true), []);
  const closeMenu = useCallback(() => setMenu(false), []);
  return (
    <Overlay open={open} onClose={close} accessibilityLabel="New todo">
      <View testID="box">
        <Pressable testID="open-confirm" onPress={openConfirm}>
          <Text>Confirm</Text>
        </Pressable>
        <Pressable testID="menu-trigger" onPress={openMenu}>
          <Text>Project</Text>
        </Pressable>
        {/* The host menu's own layer: the part that registers focus and takes keys. */}
        <MenuOverlay visible={menu} onClose={closeMenu}>
          <View testID="menu">
            <Text>Paseo</Text>
          </View>
        </MenuOverlay>
      </View>
      <Overlay open={confirming} onClose={closeConfirm} backdrop="clear">
        <View testID="confirm">
          <Text>Discard?</Text>
        </View>
      </Overlay>
    </Overlay>
  );
}

/** Stands in for Command Center: a global dialog that opens over whatever is on top. */
function GlobalDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const layer = useGlobalWebOverlayLayer("modal", open);
  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key !== "Escape") return false;
      onClose();
      return true;
    },
    [onClose],
  );
  const setScope = useWebOverlayRegistration({ active: open, layer, onKeyDown: handleKeyDown });
  const style = useMemo(() => ({ zIndex: layer }), [layer]);
  if (!open) return null;
  return createPortal(
    <div ref={setScope as RefCallback<HTMLDivElement>} style={style}>
      <input data-testid="palette-input" autoFocus />
    </div>,
    getOverlayRoot(),
  );
}

function Harness({ onClosed }: { onClosed: () => void }) {
  const [palette, setPalette] = useState(false);
  const openPalette = useCallback(() => setPalette(true), []);
  const closePalette = useCallback(() => setPalette(false), []);
  return (
    <>
      <PluginBox onClosed={onClosed} />
      <button data-testid="open-palette" type="button" onClick={openPalette} />
      <GlobalDialog open={palette} onClose={closePalette} />
    </>
  );
}

function ignore(): void {}

describe("plugin Overlay on the web", () => {
  it("renders into the shared overlay root and takes focus", async () => {
    mount(<Harness onClosed={ignore} />);
    await frames();

    const box = byTestId("box");
    expect(box).not.toBeNull();
    expect(getOverlayRoot().contains(box)).toBe(true);
    expect(box?.closest('[role="dialog"]')?.getAttribute("aria-label")).toBe("New todo");
    expect(box?.closest('[role="dialog"]')?.contains(document.activeElement)).toBe(true);
  });

  it("closes only the topmost overlay on Escape", async () => {
    const onClosed = vi.fn();
    mount(<Harness onClosed={onClosed} />);
    await frames();

    click("open-confirm");
    await frames();
    expect(byTestId("confirm")).not.toBeNull();

    pressEscape();
    expect(byTestId("confirm")).toBeNull();
    expect(byTestId("box")).not.toBeNull();
    expect(onClosed).not.toHaveBeenCalled();

    pressEscape();
    expect(byTestId("box")).toBeNull();
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  it("gives Escape to a host menu opened inside it first", async () => {
    const onClosed = vi.fn();
    mount(<Harness onClosed={onClosed} />);
    await frames();

    click("menu-trigger");
    await frames();
    expect(byTestId("menu")).not.toBeNull();

    pressEscape();
    await frames();
    expect(byTestId("menu")).toBeNull();
    expect(byTestId("box")).not.toBeNull();
    expect(onClosed).not.toHaveBeenCalled();
  });

  it("lets a global dialog open over it without a focus fight", async () => {
    const onClosed = vi.fn();
    mount(<Harness onClosed={onClosed} />);
    await frames();

    act(() => byTestId("open-palette")?.click());
    await frames(4);
    const palette = byTestId("palette-input");
    expect(document.activeElement).toBe(palette);

    // Focus stays put across several frames: the overlay below does not pull it back.
    await frames(4);
    expect(document.activeElement).toBe(palette);

    pressEscape();
    await frames();
    expect(byTestId("palette-input")).toBeNull();
    expect(byTestId("box")).not.toBeNull();
    expect(onClosed).not.toHaveBeenCalled();
  });

  it("asks to close when the backdrop is pressed", async () => {
    const onClosed = vi.fn();
    mount(<Harness onClosed={onClosed} />);
    await frames();

    click("plugin-overlay-backdrop");
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(byTestId("box")).toBeNull();
  });
});
