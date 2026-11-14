import React, { act, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { PortalProvider } from "@gorhom/portal";
import { View } from "react-native";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RetainedPanel } from "@/components/retained-panel";
import { KeyboardShiftProvider } from "@/keyboard/shift";
import type { AutocompleteOption } from "./autocomplete";
import { AutocompletePopover } from "./autocomplete-popover";
import { FloatingPanelPortalHost } from "./floating-panel-portal";

// App sources compile against the classic JSX runtime, which expects React on the global.
beforeEach(() => vi.stubGlobal("React", React));

/**
 * The popover must paint its first frame at its place. On native, Reanimated computes a style's
 * first value when its hook first runs and sends later values after the mounting commit, which
 * native paints: a bound computed while the popover was closed hung the popover over the composer
 * for a frame on every open. The frame now mounts only with a measured anchor. This suite runs the
 * web frame; the native frame was checked frame by frame on Android.
 */

const SAFE_AREA = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 0, left: 0, right: 0, bottom: 0 },
};
// The composer rests on the dock's bottom edge and grows upward, as in the app.
const COMPOSER_BOTTOM = 124;
const OFFSET_FROM_ANCHOR = 12;
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
const styleCache = new Map<string, object>();
function cachedStyle<T extends object>(key: string, create: () => T): T {
  const cached = styleCache.get(key);
  if (cached) return cached as T;
  const style = create();
  styleCache.set(key, style);
  return style;
}
function composerStyle(width: number): object {
  return cachedStyle(`composer:${width}`, () => ({
    position: "absolute" as const,
    bottom: COMPOSER_BOTTOM,
    left: 16,
    width,
  }));
}
function inputStyle(height: number): object {
  return cachedStyle(`input:${height}`, () => ({ height }));
}
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

interface ScreenProps {
  visible: boolean;
  panelActive?: boolean;
  inputHeight?: number;
  composerWidth?: number;
}

function Screen({
  visible,
  panelActive = true,
  inputHeight = 120,
  composerWidth = 358,
}: ScreenProps): ReactNode {
  return (
    <Providers>
      <RetainedPanel active={panelActive}>
        <View style={SCREEN_STYLE}>
          <View style={composerStyle(composerWidth)}>
            <AutocompletePopover
              visible={visible}
              options={OPTIONS}
              selectedIndex={OPTIONS.length - 1}
              onSelect={ignoreSelection}
            >
              <View testID="composer-input" style={inputStyle(inputHeight)} />
            </AutocompletePopover>
          </View>
          <FloatingPanelPortalHost />
        </View>
      </RetainedPanel>
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

/** Commits a change to the screen synchronously and lets the browser paint it. */
async function changeAndPaint(node: ReactNode): Promise<void> {
  flushSync(() => root?.render(node));
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      const channel = new MessageChannel();
      channel.port1.addEventListener("message", () => resolve(), { once: true });
      channel.port1.start();
      channel.port2.postMessage(null);
    });
  });
}

function rectOf(testID: string): DOMRect | null {
  return document.querySelector(`[data-testid="${testID}"]`)?.getBoundingClientRect() ?? null;
}

/** Where the popover sits against the composer, or null when it is not painted. */
function placementAgainstComposer(): { gap: number; x: number; width: number } | null {
  const popover = rectOf("composer-autocomplete-popover");
  const composer = rectOf("composer-input");
  if (!popover || !composer) return null;
  return {
    gap: Math.round(composer.top - popover.bottom),
    x: Math.round(popover.x - composer.x),
    width: Math.round(popover.width - composer.width),
  };
}

async function openSettled(props: Omit<ScreenProps, "visible"> = {}): Promise<void> {
  render(<Screen visible={false} {...props} />);
  render(<Screen visible {...props} />);
  await waitForPopover();
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(placementAgainstComposer()).toEqual({ gap: OFFSET_FROM_ANCHOR, x: 0, width: 0 });
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

/**
 * The popover lives in a portal and copies the composer's rect. A copy taken after the composer's
 * layout paints the composer at its new size against the popover's old place: the popover overlapped
 * a composer that grew a line, floated above one that shrank, and kept the old width after a resize.
 */
it("moves with the composer in the frame the composer grows", async () => {
  await openSettled();
  await changeAndPaint(<Screen visible inputHeight={160} />);
  expect(placementAgainstComposer()).toEqual({ gap: OFFSET_FROM_ANCHOR, x: 0, width: 0 });
});

it("follows the composer down when its text clears before the popover closes", async () => {
  // The input relayouts on the cleared text before the autocomplete hides the popover.
  await openSettled({ inputHeight: 160 });
  await changeAndPaint(<Screen visible inputHeight={120} />);
  expect(placementAgainstComposer()).toEqual({ gap: OFFSET_FROM_ANCHOR, x: 0, width: 0 });
});

it("matches the composer's width in the frame the composer resizes", async () => {
  await openSettled();
  await changeAndPaint(<Screen visible composerWidth={240} />);
  expect(placementAgainstComposer()).toEqual({ gap: OFFSET_FROM_ANCHOR, x: 0, width: 0 });
});

/**
 * A retained workspace stays mounted while another route shows. A popover left open there tracked a
 * composer it could not measure, and on native stopped following the composer after the user came
 * back.
 */
it("closes while its retained panel is hidden and reopens in place when it shows again", async () => {
  await openSettled();
  render(<Screen visible panelActive={false} />);
  expect(rectOf("composer-autocomplete-popover")).toBeNull();
  render(<Screen visible />);
  await waitForPopover();
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(placementAgainstComposer()).toEqual({ gap: OFFSET_FROM_ANCHOR, x: 0, width: 0 });
});
