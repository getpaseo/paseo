import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { TitlebarDragRegion } from "./titlebar-drag-region";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// Electron detection runs off the real `window.paseoDesktop` bridge the
// desktop preload installs — no module mocks. Every bridge field is optional,
// so an empty object is enough for `getIsElectronRuntime()`. Detection caches
// `true` for the module lifetime, so the negative case must run first.
function setElectronBridge(enabled: boolean): void {
  if (enabled) {
    window.paseoDesktop = {};
  } else {
    delete window.paseoDesktop;
  }
}

// The production backstop CSS lives in public/index.html; the vitest browser
// server serves public assets at the root.
let cachedBackstopCss: string | null = null;
async function loadBackstopCss(): Promise<string> {
  if (cachedBackstopCss !== null) return cachedBackstopCss;
  const response = await fetch("/index.html");
  if (!response.ok) {
    throw new Error(`index.html is not served by the vitest browser server: ${response.status}`);
  }
  const html = await response.text();
  const blocks = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((match) => match[1]);
  const backstop = blocks.find((block) => block.includes("app-region"));
  if (!backstop) {
    throw new Error("index.html no longer carries the app-region backstop style block");
  }
  cachedBackstopCss = backstop;
  return backstop;
}

/**
 * Mirrors Electron's draggable-region math: union(drag) minus union(no-drag).
 * Drag and no-drag coverage accumulate independently so a later drag rect can
 * never paper over a no-drag rect it overlaps, in any order.
 */
function draggableWidthAtRow(y: number, fromX: number, toX: number): number {
  const columns = Math.ceil((toX - fromX) / 2);
  const dragMask = Array.from({ length: columns }, () => false);
  const noDragMask = Array.from({ length: columns }, () => false);
  for (const element of document.body.querySelectorAll("*")) {
    if (!(element instanceof HTMLElement)) continue;
    const computed = window.getComputedStyle(element);
    const region = computed.getPropertyValue("-webkit-app-region");
    if (region !== "drag" && region !== "no-drag") continue;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (rect.top > y || y >= rect.bottom) continue;
    const mask = region === "drag" ? dragMask : noDragMask;
    const start = Math.max(0, Math.floor((rect.left - fromX) / 2));
    const end = Math.min(columns, Math.ceil((rect.right - fromX) / 2));
    for (let index = start; index < end; index++) mask[index] = true;
  }
  let draggable = 0;
  for (let index = 0; index < columns; index++) {
    if (dragMask[index] && !noDragMask[index]) draggable++;
  }
  return draggable * 2;
}

const surfaceStyle = { position: "relative", height: 36, width: 600 } as const;
const contentStyle = { position: "relative", overflow: "hidden", height: 600 } as const;
const scrolledTextStyle = { marginTop: -2000, height: 4000 } as const;
const floatingLayerStyle = { position: "fixed", top: 0, left: 500 } as const;
const surfaceTabStyle = { width: 120, height: 28 } as const;
const scrolledItemStyle = { width: 600, height: 3000 } as const;
const floatingItemStyle = { width: 80, height: 24 } as const;

function Scenario() {
  return (
    <>
      {/* Titlebar strip: a drag surface with an interactive tab chip */}
      <div data-testid="surface" style={surfaceStyle}>
        <TitlebarDragRegion />
        <button type="button" data-testid="surface-tab" style={surfaceTabStyle}>
          Tab
        </button>
      </div>
      {/* Content area below the strip holding a scrolled-out list whose layout
          rects pass through the strip band, like a long chat history does. */}
      <div data-testid="content" style={contentStyle}>
        <div style={scrolledTextStyle}>
          <button type="button" data-testid="scrolled-out-item" style={scrolledItemStyle}>
            history item
          </button>
        </div>
      </div>
      {/* Floating layer that can overlap a strip */}
      <div data-paseo-no-drag-scope="true" style={floatingLayerStyle}>
        <button type="button" data-testid="floating-item" style={floatingItemStyle}>
          Menu
        </button>
      </div>
    </>
  );
}

const roots: Root[] = [];

afterEach(() => {
  setElectronBridge(false);
  for (const root of roots.splice(0)) {
    act(() => root.unmount());
  }
  document.body.innerHTML = "";
});

describe("TitlebarDragRegion draggable-region cascade", () => {
  // Runs before the Electron-mode test: detection caches `true` for the module
  // lifetime once the bridge appears, so the negative case must go first.
  it("renders nothing outside Electron", () => {
    setElectronBridge(false);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    act(() => root.render(<TitlebarDragRegion />));
    expect(container.innerHTML).toBe("");
  });

  it("keeps the strip draggable when scrolled-out content passes through it", async () => {
    setElectronBridge(true);
    const style = document.createElement("style");
    style.textContent = await loadBackstopCss();
    document.head.appendChild(style);

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    act(() => root.render(<Scenario />));

    const overlay = document.querySelector<HTMLElement>("[data-paseo-drag-overlay]");
    expect(overlay).not.toBeNull();
    expect(overlay?.style.getPropertyValue("-webkit-app-region")).toBe("drag");

    // In-surface interactive elements stay no-drag so they remain clickable.
    const surfaceTab = document.querySelector<HTMLElement>("[data-testid='surface-tab']");
    expect(window.getComputedStyle(surfaceTab!).getPropertyValue("-webkit-app-region")).toBe(
      "no-drag",
    );

    // Floating-layer interactive elements stay no-drag.
    const floatingItem = document.querySelector<HTMLElement>("[data-testid='floating-item']");
    expect(window.getComputedStyle(floatingItem!).getPropertyValue("-webkit-app-region")).toBe(
      "no-drag",
    );

    // Scrolled-out content contributes nothing: no declaration of its own and
    // no no-drag ancestor to inherit from.
    const scrolledOut = document.querySelector<HTMLElement>("[data-testid='scrolled-out-item']");
    expect(window.getComputedStyle(scrolledOut!).getPropertyValue("-webkit-app-region")).toBe(
      "none",
    );

    // The strip stays draggable right of the tab chip even though the
    // scrolled-out item's layout box covers the whole strip band. The floating
    // button intentionally keeps subtracting where it overlaps the strip.
    const surface = document.querySelector<HTMLElement>("[data-testid='surface']")!;
    const surfaceRect = surface.getBoundingClientRect();
    const freeFrom = surfaceRect.left + 130;
    const freeTo = surfaceRect.left + 500;
    expect(draggableWidthAtRow(18, freeFrom, freeTo)).toBe(freeTo - freeFrom);
  });
});
