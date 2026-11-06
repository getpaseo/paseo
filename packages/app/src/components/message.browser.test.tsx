import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n as testI18n } from "@/i18n/i18next";
import { ExpandableBadge } from "./message";

// Load translations so the open-file action exposes its real accessible name.
void testI18n;

// The toast host imports `ToastAndroid`, which react-native-web does not export, and nothing here
// shows a toast.
vi.mock("@/components/toast-host", () => ({
  ToastViewport: () => null,
  useToastHost: () => ({ api: { show: () => () => {}, copied: () => {}, error: () => {} } }),
}));

// App sources compile against the classic JSX runtime, which expects React on the global.
beforeEach(() => vi.stubGlobal("React", React));

/**
 * A real browser, because the bug only exists in the DOM react-native-web produces: the badge
 * header renders as a <button>, and the open-file action that appears on hover rendered as a
 * second <button> inside it, which React reports as "<button> cannot contain a nested <button>".
 */

interface Mounted {
  root: Root;
  container: HTMLDivElement;
}

const mounted: Mounted[] = [];

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

function mount(node: React.ReactNode): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  mounted.push({ root, container });
  return container;
}

function hover(element: Element): void {
  act(() => {
    element.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
  });
}

function badgeWithOpenFile() {
  const onToggle = vi.fn();
  const onOpenFile = vi.fn();
  const container = mount(
    <ExpandableBadge
      label="Read"
      secondaryLabel="src/index.ts"
      isExpanded={false}
      onToggle={onToggle}
      onOpenFile={onOpenFile}
      testID="tool-call-badge"
    />,
  );
  const badge = container.querySelector('[data-testid="tool-call-badge"]');
  if (!badge) throw new Error("tool-call badge did not render");
  hover(badge);
  const openFile = container.querySelector('[data-testid="tool-call-open-file"]');
  if (!(openFile instanceof HTMLElement))
    throw new Error("open-file action did not appear on hover");
  return { container, openFile, onToggle, onOpenFile };
}

describe("tool-call badge open-file action", () => {
  it("is not a button nested inside the badge's button", () => {
    const { container, openFile } = badgeWithOpenFile();

    // It still sits inside the badge header's button; it just must not be one itself.
    expect(openFile.tagName).not.toBe("BUTTON");
    expect(container.querySelectorAll("button button")).toHaveLength(0);
  });

  it("opens the file without toggling the badge", () => {
    const { openFile, onToggle, onOpenFile } = badgeWithOpenFile();

    act(() => openFile.click());

    expect(onOpenFile).toHaveBeenCalledTimes(1);
    expect(onToggle).not.toHaveBeenCalled();
  });
});
