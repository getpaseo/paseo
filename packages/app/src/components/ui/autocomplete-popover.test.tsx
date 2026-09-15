import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { View } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutocompleteOption } from "@/components/ui/autocomplete";
import {
  KeyboardShiftContext,
  type KeyboardShiftContextValue,
} from "@/hooks/keyboard-shift-context";
import { SPACING } from "@/styles/theme";
import { AutocompletePopover } from "./autocomplete-popover";

/** The gap the popover keeps between itself and the anchor. */
const OFFSET_FROM_ANCHOR = SPACING[3];

/**
 * The portal host is registered by an effect in `FloatingPanelPortalHost` and measured through
 * the DOM, so on desktop it can answer `null` for the first frames after the popover mounts.
 * `unmeasurableAttempts` reproduces that window without depending on a real layout engine.
 */
const host = vi.hoisted(() => ({
  attempts: 0,
  unmeasurableAttempts: 0,
  rect: { x: 0, y: 0, width: 600, height: 900 },
}));

vi.mock("@/components/ui/floating-panel-portal", () => ({
  useFloatingPanelPortalHostName: () => "test-host",
  measureFloatingPanelPortalHost: () => {
    host.attempts += 1;
    return Promise.resolve(host.attempts <= host.unmeasurableAttempts ? null : host.rect);
  },
}));

vi.mock("@gorhom/portal", () => ({
  Portal: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("react-native-worklets", () => ({
  scheduleOnRN: (fn: () => void) => fn(),
}));

vi.mock("@/components/ui/autocomplete", async () => {
  const react = await import("react");
  return {
    Autocomplete: () => react.createElement("div", { "data-testid": "autocomplete-list" }),
  };
});

vi.mock("react-native-reanimated", async () => {
  const react = await import("react");

  const flatten = (style: unknown): Record<string, unknown> => {
    if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
    return (style as Record<string, unknown> | null) ?? {};
  };

  return {
    default: {
      View: ({
        children,
        style,
        testID,
      }: {
        children?: React.ReactNode;
        style?: unknown;
        testID?: string;
      }) =>
        react.createElement(
          "div",
          { "data-testid": testID, "data-layout": JSON.stringify(flatten(style)) },
          children,
        ),
    },
    // A real SharedValue keeps its identity across renders; a fresh object every render would
    // re-run the measurement effect and hide the bug under test.
    useSharedValue: (initial: number) => react.useRef({ value: initial }).current,
    useAnimatedStyle: (factory: () => object) => factory(),
    useAnimatedReaction: () => undefined,
  };
});

const ANCHOR = { x: 24, y: 620, width: 320, height: 44 };

const anchorRef = {
  current: {
    measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => {
      callback(ANCHOR.x, ANCHOR.y, ANCHOR.width, ANCHOR.height);
    },
  },
} as unknown as React.RefObject<View | null>;

const keyboardShift: KeyboardShiftContextValue = {
  shift: { value: 0 },
  layoutShift: { value: 0 },
  isMoving: { value: false },
  bottomInset: { value: 0 },
} as unknown as KeyboardShiftContextValue;

const noop = (): void => undefined;

const OPTIONS: AutocompleteOption[] = [
  { id: "compact", label: "/compact" },
  { id: "clear", label: "/clear" },
  { id: "review", label: "/review" },
];

let root: Root | null = null;
let container: HTMLElement | null = null;

function render(props: {
  visible: boolean;
  options: readonly AutocompleteOption[];
  selectedIndex: number;
}): void {
  act(() =>
    root?.render(
      <KeyboardShiftContext.Provider value={keyboardShift}>
        <AutocompletePopover
          visible={props.visible}
          anchorRef={anchorRef}
          options={props.options}
          selectedIndex={props.selectedIndex}
          onSelect={noop}
        />
      </KeyboardShiftContext.Provider>,
    ),
  );
}

/** The setup file backs `requestAnimationFrame` with a zero timeout, so one macrotask is one frame. */
async function flushFrames(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function popover(): HTMLElement | null {
  return container?.querySelector('[data-testid="composer-autocomplete-popover"]') ?? null;
}

/**
 * The order the composer actually produces when a slash command list is already loaded:
 * the options land one render before `useAutocomplete`'s effect picks the first index, so
 * `canMeasure` is false for that render and flips true on the next one.
 */
function openSlashAutocomplete(): void {
  render({ visible: false, options: [], selectedIndex: -1 });
  render({ visible: true, options: OPTIONS, selectedIndex: -1 });
  render({ visible: true, options: OPTIONS, selectedIndex: 0 });
}

beforeEach(() => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
  vi.stubGlobal("Node", dom.window.Node);
  vi.stubGlobal("navigator", dom.window.navigator);

  host.attempts = 0;
  host.unmeasurableAttempts = 0;

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

describe("AutocompletePopover", () => {
  it("anchors itself to the portal host once both are measurable", async () => {
    openSlashAutocomplete();
    await flushFrames(2);

    const rendered = popover();
    expect(rendered).not.toBeNull();
    expect(JSON.parse(rendered?.dataset.layout ?? "{}")).toMatchObject({
      left: ANCHOR.x - host.rect.x,
      width: ANCHOR.width,
      bottom: host.rect.height - (ANCHOR.y - host.rect.y) + OFFSET_FROM_ANCHOR,
    });
  });

  it("keeps measuring until the portal host is laid out", async () => {
    // #4872: opening the popover measures twice, once now and once next frame. On desktop the
    // host can answer `null` for longer than that, and nothing re-triggers measurement
    // afterwards, so the popover stays hidden until the window is resized.
    host.unmeasurableAttempts = 2;

    openSlashAutocomplete();
    await flushFrames(8);

    const rendered = popover();
    expect(rendered).not.toBeNull();
    expect(JSON.parse(rendered?.dataset.layout ?? "{}")).toMatchObject({
      left: ANCHOR.x - host.rect.x,
      width: ANCHOR.width,
      bottom: host.rect.height - (ANCHOR.y - host.rect.y) + OFFSET_FROM_ANCHOR,
    });
  });

  it("gives up after a bounded number of frames when the host never becomes measurable", async () => {
    host.unmeasurableAttempts = Number.MAX_SAFE_INTEGER;

    openSlashAutocomplete();
    await flushFrames(40);

    expect(popover()).toBeNull();
    // It retried past the two attempts opening the popover makes on its own,
    expect(host.attempts).toBeGreaterThan(2);
    // and it stopped rather than polling for as long as the popover is open.
    const attemptsAfterGivingUp = host.attempts;

    await flushFrames(20);
    expect(host.attempts).toBe(attemptsAfterGivingUp);
  });

  it("does not keep scheduling measurements after it unmounts", async () => {
    host.unmeasurableAttempts = Number.MAX_SAFE_INTEGER;

    openSlashAutocomplete();
    await flushFrames(1);

    act(() => root?.unmount());
    root = null;
    const attemptsAtUnmount = host.attempts;

    await flushFrames(10);
    expect(host.attempts).toBe(attemptsAtUnmount);
  });
});
