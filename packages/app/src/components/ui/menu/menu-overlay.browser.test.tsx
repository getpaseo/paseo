import React, { act, useEffect, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Text, View } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import {
  MenuItem,
  MenuRoot,
  MenuSubTrigger,
  MenuSurface,
  MenuTrigger,
  type MenuPageDefinition,
  type Size,
} from "./index";

// App sources compile against the classic JSX runtime, which expects React on the global.
beforeEach(() => vi.stubGlobal("React", React));

/**
 * A real browser, because the regression lives in Reanimated's web entering path: it snapshots
 * the surface's rect when a custom keyframe ends and writes that rect back as inline
 * top/left/width/height when it cleans the keyframe up, 750ms after the animation starts.
 * Anything that moved or resized the surface in between is undone by that write.
 */

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

const OFFSET = 12;
const PILL_POSITION = { position: "absolute", top: 700, left: 40 } as const;
const SHORT: Size = { width: 200, height: 40 };
const TALL: Size = { width: 200, height: 240 };
const WIDE: Size = { width: 480, height: 40 };
/** Inside the window between the entering animation ending and Reanimated's cleanup. */
const GROWS_BEFORE_CLEANUP_MS = 400;
/** Past Reanimated's cleanup, where the surface used to keep a fixed height. */
const GROWS_AFTER_CLEANUP_MS = 1_000;
/** Long enough after the content grew for anything that would write to the surface to land. */
const SETTLE_MS = 1_200;

/** Plain timers, not `act`: an async `act` holds every update until it resolves. */
function wait(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function element(testID: string): HTMLElement {
  const found = document.querySelector(`[data-testid="${testID}"]`);
  if (!(found instanceof HTMLElement)) throw new Error(`${testID} did not render`);
  return found;
}

/** Stands in for a popover whose data lands after it opened, like a plugin's first RPC. */
function GrowsAfterOpen({ afterMs, from, to }: { afterMs: number; from: Size; to: Size }) {
  const [grown, setGrown] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setGrown(true), afterMs);
    return () => clearTimeout(timer);
  }, [afterMs]);
  return <View testID="body" style={grown ? to : from} />;
}

function mountMenuAbovePill(body: ReactNode): void {
  mount(
    <View style={PILL_POSITION}>
      <MenuRoot>
        <MenuTrigger testID="pill" accessibilityLabel="Open panel">
          <Text>Open panel</Text>
        </MenuTrigger>
        <MenuSurface
          side="top"
          align="start"
          offset={OFFSET}
          minWidth={280}
          maxWidth={620}
          testID="panel"
        >
          {body}
        </MenuSurface>
      </MenuRoot>
    </View>,
  );
  act(() => element("pill").click());
}

describe("anchored menu surface on web", () => {
  beforeEach(async () => {
    await page.viewport(1280, 900);
  });

  it.each([GROWS_BEFORE_CLEANUP_MS, GROWS_AFTER_CLEANUP_MS])(
    "stays on its anchor when its content grows %ims after opening",
    async (afterMs) => {
      mountMenuAbovePill(<GrowsAfterOpen afterMs={afterMs} from={SHORT} to={TALL} />);

      await wait(afterMs + SETTLE_MS);

      const pill = element("pill").getBoundingClientRect();
      const panel = element("panel").getBoundingClientRect();
      expect(panel.height).toBeGreaterThan(240);
      expect(panel.bottom).toBeLessThanOrEqual(pill.top);
    },
  );

  it("widens when its content widens after the entering animation", async () => {
    mountMenuAbovePill(<GrowsAfterOpen afterMs={GROWS_BEFORE_CLEANUP_MS} from={SHORT} to={WIDE} />);

    await wait(GROWS_BEFORE_CLEANUP_MS + SETTLE_MS);

    const body = element("body").getBoundingClientRect();
    const panel = element("panel").getBoundingClientRect();
    expect(panel.width).toBeGreaterThanOrEqual(body.width);
  });
});

const SUB_PAGES: MenuPageDefinition[] = [
  {
    id: "show",
    title: "Show",
    content: (
      <MenuItem testID="show-option" closeOnSelect={false}>
        Archived
      </MenuItem>
    ),
  },
];

/** Past the grace a flyout is given after the pointer leaves, so a queued close has landed. */
const HOVER_CLOSE_SETTLED_MS = 600;

/**
 * A tap as the browser reports it: the finger enters the row as it lands and leaves it as it
 * lifts, and only then does the click arrive.
 */
function tap(target: HTMLElement): void {
  const pointer = (type: string) =>
    target.dispatchEvent(
      new PointerEvent(type, { bubbles: true, pointerType: "touch", isPrimary: true }),
    );
  act(() => {
    pointer("pointerover");
    pointer("pointerdown");
    pointer("pointerup");
    pointer("pointerout");
    target.click();
  });
}

describe("submenu flyout on a touch screen", () => {
  beforeEach(async () => {
    await page.viewport(1280, 900);
  });

  it("stays open after a tap on its row, and after a tap inside it", async () => {
    mount(
      <MenuRoot>
        <MenuTrigger testID="pill" accessibilityLabel="Open menu">
          <Text>Open menu</Text>
        </MenuTrigger>
        <MenuSurface pages={SUB_PAGES} testID="panel">
          <MenuSubTrigger id="show" testID="show-row">
            Show
          </MenuSubTrigger>
        </MenuSurface>
      </MenuRoot>,
    );
    act(() => element("pill").click());

    tap(element("show-row"));
    await wait(HOVER_CLOSE_SETTLED_MS);
    tap(element("show-option"));
    await wait(HOVER_CLOSE_SETTLED_MS);

    expect(document.querySelector('[data-testid="show-option"]')).not.toBeNull();
  });
});
