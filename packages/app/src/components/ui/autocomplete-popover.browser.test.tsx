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
  options?: AutocompleteOption[];
  /** Counted up from the best match, which is the last option. */
  selectedFromBest?: number;
}

function Screen({
  visible,
  panelActive = true,
  inputHeight = 120,
  composerWidth = 358,
  options = OPTIONS,
  selectedFromBest = 0,
}: ScreenProps): ReactNode {
  return (
    <Providers>
      <RetainedPanel active={panelActive}>
        <View style={SCREEN_STYLE}>
          <View style={composerStyle(composerWidth)}>
            <AutocompletePopover
              visible={visible}
              options={options}
              selectedIndex={options.length - 1 - selectedFromBest}
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

/** As many commands as a workspace with skills installed lists; the best match is last. */
function commandOptions(prefix: string, count: number): AutocompleteOption[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${count - index}`,
    label: `/${prefix}-${count - index}`,
    icon: "skill" as const,
    description: `Description of ${prefix} ${count - index}`,
    tag: "Skill",
  }));
}

const LIST_PADDING_AND_BORDER = 5;

/** How far the best match's row sits above the popover's bottom edge, or null when not painted. */
function bestMatchAgainstPopoverBottom(label: string): number | null {
  const popover = rectOf("composer-autocomplete-popover");
  const row = document.querySelector(`[aria-label^="${label},"]`)?.getBoundingClientRect();
  if (!popover) return null;
  if (!row) return Number.NaN;
  return Math.round(popover.bottom - row.bottom);
}

/** Samples a reading after every paint until stopped. */
function recordPaintedFrames<T>(read: () => T): { frames: T[]; stop: () => void } {
  const frames: T[] = [];
  let running = true;
  const channel = new MessageChannel();
  channel.port1.addEventListener("message", () => {
    if (running) frames.push(read());
  });
  channel.port1.start();
  const tick = (): void => {
    if (!running) return;
    channel.port2.postMessage(null);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return {
    frames,
    stop: () => {
      running = false;
    },
  };
}

/**
 * The list is longer than the popover and reads upward from its best match, which sits against the
 * bottom edge. Scrolling there after the list mounted painted the list at its old offset first: a
 * few pixels short on open, a different stretch of the list when the results changed.
 */
it("paints a long list with its best match against the bottom from the first frame", async () => {
  const options = commandOptions("skill", 100);
  render(<Screen visible={false} options={options} />);
  const recording = recordPaintedFrames(() => bestMatchAgainstPopoverBottom("/skill-1"));
  render(<Screen visible options={options} />);
  await waitForPopover();
  await new Promise((resolve) => setTimeout(resolve, 300));
  recording.stop();

  const painted = recording.frames.filter((frame) => frame !== null);
  expect(painted.length).toBeGreaterThan(0);
  expect([...new Set(painted)]).toEqual([LIST_PADDING_AND_BORDER]);
});

it("keeps the best match against the bottom in the frame the results change", async () => {
  const all = commandOptions("skill", 100);
  const fewer = all.filter((_, index) => index % 3 === 0);
  render(<Screen visible={false} options={all} />);
  render(<Screen visible options={all} />);
  await waitForPopover();
  await new Promise((resolve) => setTimeout(resolve, 300));

  // Narrowing keeps `/skill-1` the best match; widening brings the rest back above it.
  const recording = recordPaintedFrames(() => bestMatchAgainstPopoverBottom("/skill-1"));
  await changeAndPaint(<Screen visible options={fewer} />);
  await new Promise((resolve) => setTimeout(resolve, 200));
  await changeAndPaint(<Screen visible options={all} />);
  await new Promise((resolve) => setTimeout(resolve, 300));
  recording.stop();

  expect([...new Set(recording.frames)]).toEqual([LIST_PADDING_AND_BORDER]);
});

function mountedRows(prefix = "skill"): Element[] {
  return [...document.querySelectorAll(`[aria-label^="/${prefix}-"]`)];
}

/**
 * Every result used to mount before the popover's first frame, so a workspace with a hundred
 * commands waited on a hundred rows to see six.
 */
it("mounts the rows nearest the composer first, however many results there are", async () => {
  const options = commandOptions("skill", 500);
  render(<Screen visible={false} options={options} />);
  const recording = recordPaintedFrames(() =>
    rectOf("composer-autocomplete-popover") ? mountedRows().length : null,
  );
  render(<Screen visible options={options} />);
  await waitForPopover();
  await new Promise((resolve) => setTimeout(resolve, 100));
  recording.stop();

  const firstFrame = recording.frames.find((frame) => frame !== null);
  expect(firstFrame).toBeGreaterThan(0);
  expect(firstFrame).toBeLessThan(20);
  expect(bestMatchAgainstPopoverBottom("/skill-1")).toBe(LIST_PADDING_AND_BORDER);
});

/**
 * A list that had mounted its whole window kept that window for the next results, so narrowing a
 * long list to another long one waited on ten times the rows the popover shows.
 */
it("mounts the rows nearest the composer first when the results change", async () => {
  const commands = commandOptions("skill", 500);
  const matches = commandOptions("plugin", 300);
  render(<Screen visible={false} options={commands} />);
  render(<Screen visible options={commands} />);
  await waitForPopover();
  await expect.poll(() => mountedRows().length, { timeout: 3000 }).toBeGreaterThan(40);

  const recording = recordPaintedFrames(() => mountedRows("plugin").length);
  await changeAndPaint(<Screen visible options={matches} />);
  recording.stop();

  const firstFrame = recording.frames.find((count) => count > 0);
  expect(firstFrame).toBeLessThan(20);
  expect(bestMatchAgainstPopoverBottom("/plugin-1")).toBe(LIST_PADDING_AND_BORDER);
});

/** Every scroll position script gives an element inside the popover. */
function recordScrollCommands(): { count: () => number; stop: () => void } {
  let commands = 0;
  const insidePopover = (target: unknown): boolean =>
    target instanceof Element &&
    target.closest('[data-testid="composer-autocomplete-popover"]') !== null;
  const prototype = Element.prototype;
  const scroll = prototype.scroll;
  const scrollTo = prototype.scrollTo;
  const scrollTop = Object.getOwnPropertyDescriptor(prototype, "scrollTop");
  if (!scrollTop?.get || !scrollTop.set) throw new Error("Element.scrollTop is not an accessor");
  const readScrollTop = scrollTop.get;
  const writeScrollTop = scrollTop.set;
  prototype.scroll = function recordedScroll(this: Element, ...args: unknown[]) {
    if (insidePopover(this)) commands += 1;
    Reflect.apply(scroll, this, args);
  };
  prototype.scrollTo = function recordedScrollTo(this: Element, ...args: unknown[]) {
    if (insidePopover(this)) commands += 1;
    Reflect.apply(scrollTo, this, args);
  };
  Object.defineProperty(prototype, "scrollTop", {
    configurable: true,
    get(this: Element) {
      return readScrollTop.call(this);
    },
    set(this: Element, value: number) {
      if (insidePopover(this)) commands += 1;
      writeScrollTop.call(this, value);
    },
  });
  return {
    count: () => commands,
    stop: () => {
      prototype.scroll = scroll;
      prototype.scrollTo = scrollTo;
      Object.defineProperty(prototype, "scrollTop", scrollTop);
    },
  };
}

/**
 * Native paints a scroll command a frame or two after the rows it was meant for. A list that rests
 * against the composer only because script scrolled it there shows the rows somewhere else first.
 */
it("rests against the composer without a scroll command", async () => {
  const all = commandOptions("skill", 100);
  const fewer = all.filter((_, index) => index % 3 === 0);
  render(<Screen visible={false} options={all} />);
  const recording = recordScrollCommands();
  try {
    render(<Screen visible options={all} />);
    await waitForPopover();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await changeAndPaint(<Screen visible options={fewer} />);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await changeAndPaint(<Screen visible options={all} />);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(bestMatchAgainstPopoverBottom("/skill-1")).toBe(LIST_PADDING_AND_BORDER);
    expect(recording.count()).toBe(0);
  } finally {
    recording.stop();
  }
});

function scrollerOf(popover: HTMLElement): HTMLElement {
  const scroller = [...popover.querySelectorAll<HTMLElement>("*")].find(
    (element) =>
      element.scrollHeight > element.clientHeight + 1 &&
      ["auto", "scroll"].includes(getComputedStyle(element).overflowY),
  );
  if (!scroller) throw new Error("The list does not scroll");
  return scroller;
}

it("returns to the best match in the frame results arrive while the list is scrolled away", async () => {
  const all = commandOptions("skill", 100);
  const fewer = all.filter((_, index) => index % 3 === 0);
  render(<Screen visible={false} options={all} />);
  render(<Screen visible options={all} />);
  const popover = await waitForPopover();
  await new Promise((resolve) => setTimeout(resolve, 300));
  scrollerOf(popover).scrollTop = 400;
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(bestMatchAgainstPopoverBottom("/skill-1")).not.toBe(LIST_PADDING_AND_BORDER);

  const recording = recordPaintedFrames(() => bestMatchAgainstPopoverBottom("/skill-1"));
  await changeAndPaint(<Screen visible options={fewer} />);
  await new Promise((resolve) => setTimeout(resolve, 200));
  recording.stop();

  expect([...new Set(recording.frames)]).toEqual([LIST_PADDING_AND_BORDER]);
});

/** Whether the row is wholly inside the popover's box. */
function isRowInView(label: string): boolean {
  const popover = rectOf("composer-autocomplete-popover");
  const row = document.querySelector(`[aria-label^="${label},"]`)?.getBoundingClientRect();
  if (!popover || !row) return false;
  return row.top >= popover.top - 0.5 && row.bottom <= popover.bottom + 0.5;
}

it("reveals the row the arrow keys select, including across the wrap to the far end", async () => {
  const options = commandOptions("skill", 100);
  render(<Screen visible={false} options={options} />);
  render(<Screen visible options={options} />);
  await waitForPopover();
  await new Promise((resolve) => setTimeout(resolve, 300));

  for (const selectedFromBest of [1, 5, 6, 7, 12, 6, 0, 99, 98, 93, 0]) {
    render(<Screen visible options={options} selectedFromBest={selectedFromBest} />);
    // Rows beyond the mounted ones come into view as they mount.
    await expect
      .poll(() => [selectedFromBest, isRowInView(`/skill-${selectedFromBest + 1}`)], {
        timeout: 3000,
      })
      .toEqual([selectedFromBest, true]);
  }
  await expect.poll(() => bestMatchAgainstPopoverBottom("/skill-1")).toBe(LIST_PADDING_AND_BORDER);
});

it("scrolls towards rows further from the composer when the wheel turns up", async () => {
  const options = commandOptions("skill", 100);
  render(<Screen visible={false} options={options} />);
  render(<Screen visible options={options} />);
  const popover = await waitForPopover();
  await new Promise((resolve) => setTimeout(resolve, 300));

  const row = document.querySelector('[aria-label^="/skill-1,"]');
  row?.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true, cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 200));

  // The best match moved down, out of the popover, by the distance the wheel turned.
  expect(bestMatchAgainstPopoverBottom("/skill-1")).toBe(LIST_PADDING_AND_BORDER - 120);
  expect(isRowInView("/skill-7")).toBe(true);
  expect(popover.getBoundingClientRect().bottom).toBe(rectOf("composer-input")!.top - 12);
});
