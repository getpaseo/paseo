/**
 * @vitest-environment jsdom
 */
import { i18n as testI18n } from "@/i18n/i18next";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ICON_SIZE } from "@/styles/theme";
import {
  WorkspaceTabOptionRow,
  type WorkspaceTabPresentation,
} from "@/screens/workspace/workspace-tab-presentation";

vi.hoisted(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: () => ({
      matches: false,
      media: "",
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
});

void testI18n;

vi.mock("lucide-react-native", () => {
  const StubIcon = () => null;
  const Pin = ({ size }: { size?: number }) =>
    React.createElement("svg", { "data-icon": "Pin", "data-size": size });
  return {
    Check: StubIcon,
    CircleAlert: StubIcon,
    Pin,
  };
});

vi.mock("@/components/status-ring", () => ({
  StatusRing: () => null,
}));

vi.mock("@/panels/register-panels", () => ({
  ensurePanelsRegistered: () => undefined,
}));

vi.mock("@/panels/panel-registry", () => ({
  getPanelRegistration: () => undefined,
}));

vi.mock("@/panels/panel-instance-attributes", () => ({
  usePanelInstanceAttributes: () => ({ modified: false }),
}));

const presentation: WorkspaceTabPresentation = {
  key: "file_source.ts",
  kind: "file",
  label: "source.ts",
  subtitle: "src/source.ts",
  tooltip: "src/source.ts",
  modified: false,
  titleState: "ready",
  icon: () => null,
  statusBucket: null,
};

describe("WorkspaceTabOptionRow pin affordance", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  function renderRow(isPinned: boolean) {
    act(() => {
      root.render(
        <WorkspaceTabOptionRow
          presentation={presentation}
          isPinned={isPinned}
          selected={false}
          active={false}
          onPress={vi.fn()}
        />,
      );
    });
  }

  function getPinSlot(): HTMLElement {
    const slot = container.firstElementChild?.firstElementChild?.children.item(1);
    if (!(slot instanceof HTMLElement)) {
      throw new Error("Workspace tab pin slot did not render");
    }
    return slot;
  }

  it("keeps the pin slot geometry stable while toggling the rendered pin", () => {
    renderRow(false);

    const unpinnedSlot = getPinSlot();
    const unpinnedGeometry = {
      width: getComputedStyle(unpinnedSlot).width,
      height: getComputedStyle(unpinnedSlot).height,
      flexShrink: getComputedStyle(unpinnedSlot).flexShrink,
    };
    expect(container.querySelector('[data-icon="Pin"]')).toBeNull();
    expect(unpinnedGeometry).toEqual({
      width: `${ICON_SIZE.xs}px`,
      height: `${ICON_SIZE.xs}px`,
      flexShrink: "0",
    });

    renderRow(true);

    const pinnedSlot = getPinSlot();
    const pin = container.querySelector('[data-icon="Pin"]');
    expect(pinnedSlot).toBe(unpinnedSlot);
    expect(pin?.getAttribute("data-size")).toBe(String(ICON_SIZE.xs));
    expect({
      width: getComputedStyle(pinnedSlot).width,
      height: getComputedStyle(pinnedSlot).height,
      flexShrink: getComputedStyle(pinnedSlot).flexShrink,
    }).toEqual(unpinnedGeometry);
  });
});
