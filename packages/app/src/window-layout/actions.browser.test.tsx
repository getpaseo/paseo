import React, { act, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { PortalProvider } from "@gorhom/portal";
import { afterEach, expect, it, vi } from "vitest";
import { Pressable, StyleSheet } from "react-native";
import type { WindowLayout } from "./model";
import { WindowLayoutContext } from "./context";
import { WindowLayoutActions, WindowLayoutActionsHost } from "./actions";
import { WindowLayoutDivisionGap } from "./surface";
import { lightTheme } from "@/styles/theme";
import { useIconButtonChromeStyle } from "@/components/ui/icon-button-chrome";

vi.stubGlobal("React", React);
const layout = { sidebarWidth: 465, gap: 21, contentWidth: 381 };
const geometry: WindowLayout = {
  bounds: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight },
  verticalBarEdge: "trailing",
  verticalBar: { x: 20, y: 20, width: 44, height: 400 },
  divisions: [],
};
const container = document.createElement("div");
document.body.appendChild(container);
const root = createRoot(container);
afterEach(() => {
  act(() => root.render(null));
});

it("paints the reserved division with the sidebar surface", () => {
  act(() =>
    root.render(<WindowLayoutDivisionGap layout={layout} sidebarVisible compact={false} />),
  );
  const gap = container.firstElementChild as HTMLElement;
  const expected = document.createElement("div");
  expected.style.backgroundColor = lightTheme.colors.surfaceSidebar;
  expect(getComputedStyle(gap).backgroundColor).toBe(expected.style.backgroundColor);
  expect(getComputedStyle(gap).borderRightWidth).toBe("1px");
  expect(gap.getBoundingClientRect().width).toBe(21);
});

it("keeps pending action work alive while the bar is hidden and preserves circular chrome", async () => {
  let complete: () => void = () => {};
  let completed = false;
  const delayed = new Promise<void>((resolve) => {
    complete = resolve;
  });
  function PendingAction() {
    const [pending, setPending] = useState(false);
    useEffect(() => {
      if (!pending) return;
      let mounted = true;
      void delayed.then(() => {
        if (mounted) completed = true;
        return undefined;
      });
      return () => {
        mounted = false;
      };
    }, [pending]);
    const style = useIconButtonChromeStyle({ size: "small" });
    const restart = useCallback(() => setPending(true), []);
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Restart"
        onPress={restart}
        style={StyleSheet.flatten(style({ open: true }))}
      />
    );
  }
  function Scene({ active }: { active: boolean }) {
    return (
      <PortalProvider>
        <WindowLayoutContext.Provider value={geometry}>
          <WindowLayoutActionsHost />
          <WindowLayoutActions active={active}>
            <PendingAction />
          </WindowLayoutActions>
        </WindowLayoutContext.Provider>
      </PortalProvider>
    );
  }
  await act(async () => root.render(<Scene active />));
  const button = container.querySelector('[aria-label="Restart"]') as HTMLElement;
  expect(button).not.toBeNull();
  expect(getComputedStyle(button).borderRadius).toBe(`${lightTheme.borderRadius.full}px`);
  await act(async () => button.click());
  await act(async () => root.render(<Scene active={false} />));
  await act(async () => {
    complete();
    await delayed;
  });
  expect(completed).toBe(true);
  expect(
    container.querySelector('[data-testid="workspace-vertical-actions"]')?.getBoundingClientRect()
      .height,
  ).toBe(0);
  await act(async () => root.render(<Scene active />));
  expect(container.querySelector('[aria-label="Restart"]')).not.toBeNull();
});
