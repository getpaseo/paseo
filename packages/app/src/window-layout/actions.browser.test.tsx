import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { PortalProvider } from "@gorhom/portal";
import { afterEach, expect, it, vi } from "vitest";
import { Text } from "react-native";
import { page } from "vitest/browser";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { HeaderToggleButton } from "@/components/headers/header-toggle-button";
import type { WindowLayout } from "./model";
import { WindowLayoutContext } from "./context";
import { WindowLayoutActions, WindowLayoutActionsHost } from "./actions";
import { WindowLayoutDivisionGap } from "./surface";
import { lightTheme } from "@/styles/theme";

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

const explorerState = { expanded: false };
const noKeys: [] = [];
const noop = () => {};

it("preserves circular explorer chrome and closes a portaled menu when actions become inactive", async () => {
  async function renderActions(active: boolean) {
    await act(async () =>
      root.render(
        <PortalProvider>
          <WindowLayoutContext.Provider value={geometry}>
            <WindowLayoutActionsHost />
            <WindowLayoutActions active={active}>
              <HeaderToggleButton
                onPress={noop}
                accessibilityRole="button"
                accessibilityLabel="Explorer"
                tooltipLabel="Explorer"
                tooltipSide="left"
                tooltipKeys={noKeys}
                accessibilityState={explorerState}
              >
                <Text>Explorer</Text>
              </HeaderToggleButton>
              <DropdownMenu>
                <DropdownMenuTrigger accessibilityRole="button" accessibilityLabel="Bar menu">
                  <Text>Menu</Text>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuItem onSelect={noop}>Bar menu item</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </WindowLayoutActions>
          </WindowLayoutContext.Provider>
        </PortalProvider>,
      ),
    );
  }
  await renderActions(true);
  const explorer = container.querySelector('[aria-label="Explorer"]') as HTMLElement;
  expect(getComputedStyle(explorer).borderRadius).toBe(`${lightTheme.borderRadius.full}px`);
  await page.getByRole("button", { name: "Bar menu", exact: true }).click();
  await expect.element(page.getByRole("menuitem", { name: "Bar menu item" })).toBeVisible();
  await renderActions(false);
  await expect.poll(() => document.querySelectorAll('[role="menuitem"]').length).toBe(0);
  expect(
    container.querySelector('[data-testid="workspace-vertical-actions"]')?.getBoundingClientRect()
      .height,
  ).toBe(0);
});
