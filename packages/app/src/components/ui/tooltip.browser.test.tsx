import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Pressable, Text } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MenuRoot, MenuTrigger } from "@/components/ui/menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

// App sources compile against the classic JSX runtime, which expects React on the global.
beforeEach(() => vi.stubGlobal("React", React));

// The press-only layout is the one that has no hover, so long press is its only path to a tooltip.
vi.mock("@/constants/layout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/constants/layout")>();
  return { ...actual, useIsCompactFormFactor: () => true };
});

// Animation is not the subject here, and Reanimated's web layout animations
// throw in a bare browser harness that does not boot the app runtime.
vi.mock("react-native-reanimated", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-native-reanimated")>();
  const { View } = await import("react-native");
  return {
    ...actual,
    default: { ...actual.default, View },
    FadeIn: { duration: () => ({}) },
    FadeOut: { duration: () => ({}) },
  };
});

interface Mounted {
  root: Root;
  container: HTMLDivElement;
}

const mounted: Mounted[] = [];

function mount(node: ReactNode): void {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  mounted.push({ root, container });
}

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

function renderPill({
  onPress,
  openOnLongPress = true,
}: {
  onPress: () => void;
  openOnLongPress?: boolean;
}): void {
  mount(
    <Tooltip openOnLongPress={openOnLongPress}>
      <TooltipTrigger asChild>
        <Pressable onPress={onPress} testID="pill">
          <Text>Kontor</Text>
        </Pressable>
      </TooltipTrigger>
      <TooltipContent testID="tooltip">
        <Text>LSA • Idle</Text>
      </TooltipContent>
    </Tooltip>,
  );
}

function renderMenuPill({ onOpenChange }: { onOpenChange: (open: boolean) => void }): void {
  mount(
    <MenuRoot onOpenChange={onOpenChange}>
      <Tooltip openOnLongPress>
        <TooltipTrigger asChild>
          <MenuTrigger testID="pill">
            <Text>Kontor</Text>
          </MenuTrigger>
        </TooltipTrigger>
        <TooltipContent testID="tooltip">
          <Text>LSA • Idle</Text>
        </TooltipContent>
      </Tooltip>
    </MenuRoot>,
  );
}

function pill(): HTMLElement {
  const found = document.querySelector('[data-testid="pill"]');
  if (!(found instanceof HTMLElement)) throw new Error("the pill did not render");
  return found;
}

function tooltip(): HTMLElement | null {
  const found = document.querySelector('[data-testid="tooltip"]');
  if (found === null) return null;
  if (!(found instanceof HTMLElement)) throw new Error("the tooltip is not an element");
  return found;
}

function mouse(type: "mousedown" | "mouseup" | "click"): void {
  pill().dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0 }));
}

/** Real time, because the long-press delay runs on the browser's timer. */
function wait(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

const PAST_LONG_PRESS_MS = 600;

describe("TooltipTrigger press-and-hold", () => {
  it("shows the tooltip after a hold without running the pill action", async () => {
    const onPress = vi.fn();
    renderPill({ onPress });

    mouse("mousedown");
    await wait(PAST_LONG_PRESS_MS);

    expect(tooltip()?.textContent).toContain("LSA • Idle");

    mouse("mouseup");
    mouse("click");

    expect(onPress).not.toHaveBeenCalled();
    expect(tooltip()?.textContent).toContain("LSA • Idle");
  });

  it("keeps a short tap as the pill action", () => {
    const onPress = vi.fn();
    renderPill({ onPress });

    mouse("mousedown");
    mouse("mouseup");
    mouse("click");

    expect(onPress).toHaveBeenCalledTimes(1);
    expect(tooltip()).toBeNull();
  });

  it("keeps press-and-hold off unless the call site opts in", async () => {
    const onPress = vi.fn();
    renderPill({ onPress, openOnLongPress: false });

    mouse("mousedown");
    await wait(PAST_LONG_PRESS_MS);

    expect(tooltip()).toBeNull();

    mouse("mouseup");
    mouse("click");

    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("opens the tooltip on a hold for a pill that opens a menu", async () => {
    const onOpenChange = vi.fn();
    renderMenuPill({ onOpenChange });

    mouse("mousedown");
    await wait(PAST_LONG_PRESS_MS);

    expect(tooltip()?.textContent).toContain("LSA • Idle");

    mouse("mouseup");
    mouse("click");

    expect(onOpenChange).not.toHaveBeenCalledWith(true);
  });

  it("keeps a short tap on a menu pill opening the menu", () => {
    const onOpenChange = vi.fn();
    renderMenuPill({ onOpenChange });

    mouse("mousedown");
    mouse("mouseup");
    mouse("click");

    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(tooltip()).toBeNull();
  });
});
