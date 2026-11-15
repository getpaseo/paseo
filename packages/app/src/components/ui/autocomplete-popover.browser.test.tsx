import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PortalProvider } from "@gorhom/portal";
import { View } from "react-native";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { KeyboardShiftProvider } from "@/keyboard/shift";
import type { AutocompleteOption } from "./autocomplete";
import { AutocompletePopover } from "./autocomplete-popover";
import { FloatingPanelPortalHost } from "./floating-panel-portal";

// App sources compile against the classic JSX runtime, which expects React on the global.
beforeEach(() => vi.stubGlobal("React", React));

/**
 * The popover's height bound is a Reanimated style. Reanimated computes a style's first value
 * when its hook first runs and sends later values from an effect, after the commit that mounts
 * the view. Native paints that commit: a bound computed while the popover was closed painted the
 * popover at its minimum height, hanging down over the composer, for a frame on every open.
 * Web runs the effect before paint, so the wrong value only shows as the first style the DOM
 * receives.
 */

const SAFE_AREA = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 0, left: 0, right: 0, bottom: 0 },
};
const COMPOSER_TOP = 600;
const OPTIONS: AutocompleteOption[] = ["help", "hello", "history"].map((name) => ({
  id: name,
  label: `/${name}`,
  icon: "command",
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

const SCREEN_STYLE = { width: 390, height: 844 };
const COMPOSER_STYLE = { position: "absolute" as const, top: COMPOSER_TOP, left: 16, width: 358 };
const INPUT_STYLE = { height: 120 };
function ignoreSelection(): void {}

function Providers({ children }: { children: ReactNode }): ReactNode {
  return (
    <SafeAreaProvider initialMetrics={SAFE_AREA}>
      <KeyboardProvider>
        <KeyboardShiftProvider>
          <PortalProvider>{children}</PortalProvider>
        </KeyboardShiftProvider>
      </KeyboardProvider>
    </SafeAreaProvider>
  );
}

function Screen({ visible }: { visible: boolean }): ReactNode {
  return (
    <Providers>
      <View style={SCREEN_STYLE}>
        <View style={COMPOSER_STYLE}>
          <AutocompletePopover
            visible={visible}
            options={OPTIONS}
            selectedIndex={OPTIONS.length - 1}
            onSelect={ignoreSelection}
          >
            <View style={INPUT_STYLE} />
          </AutocompletePopover>
        </View>
        <FloatingPanelPortalHost />
      </View>
    </Providers>
  );
}

function render(node: ReactNode): void {
  if (!container) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  act(() => root?.render(node));
}

/** Every max-height the popover's frame has held, starting with the one it mounted with. */
function recordPopoverMaxHeights(): { values: string[]; stop: () => void } {
  const values: string[] = [];
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "childList") {
        for (const node of record.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          const popover = node.matches('[data-testid="composer-autocomplete-popover"]')
            ? node
            : node.querySelector<HTMLElement>('[data-testid="composer-autocomplete-popover"]');
          // The attribute records below carry what the style was before each change; this
          // carries the style at insertion when nothing changed it afterwards.
          if (popover && values.length === 0) values.push(popover.style.maxHeight);
        }
      }
      if (
        record.type === "attributes" &&
        record.target instanceof HTMLElement &&
        record.target.dataset.testid === "composer-autocomplete-popover"
      ) {
        const before = /max-height:\s*([^;]+)/.exec(record.oldValue ?? "")?.[1]?.trim() ?? "";
        if (values.length <= 1) values.splice(0, values.length, before);
        values.push(record.target.style.maxHeight);
      }
    }
  });
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["style"],
    attributeOldValue: true,
  });
  return { values, stop: () => observer.disconnect() };
}

async function waitForPopover(): Promise<HTMLElement> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const popover = document.querySelector<HTMLElement>(
      '[data-testid="composer-autocomplete-popover"]',
    );
    if (popover) return popover;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("The popover did not open");
}

it("opens with its height bound instead of the bound it had while closed", async () => {
  // The composer mounts first and opens the popover later, as typing `/` does.
  render(<Screen visible={false} />);
  const recording = recordPopoverMaxHeights();
  render(<Screen visible />);
  const popover = await waitForPopover();
  await new Promise((resolve) => setTimeout(resolve, 200));
  recording.stop();

  const settled = popover.style.maxHeight;
  expect(Number.parseFloat(settled)).toBeGreaterThan(0);
  expect(recording.values[0]).toBe(settled);
});
