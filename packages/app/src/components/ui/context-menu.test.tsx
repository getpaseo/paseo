import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextMenuTrigger } from "./context-menu";

const captured = vi.hoisted(() => ({
  style: undefined as unknown,
}));

vi.mock("react-native", () => ({
  Platform: { OS: "web" },
  StatusBar: {},
}));

vi.mock("@/constants/platform", () => ({
  isNative: false,
  isWeb: true,
}));

vi.mock("@/components/ui/menu", () => ({
  MenuHint: () => null,
  MenuItem: () => null,
  MenuLabel: () => null,
  MenuRoot: () => null,
  MenuSeparator: () => null,
  MenuSurface: () => null,
  useMenuContext: () => ({
    open: false,
    setAnchorRect: vi.fn(),
    setOpen: vi.fn(),
    triggerRef: undefined,
  }),
}));

vi.mock("@/components/ui/press-highlight", () => ({
  PressHighlight: (props: { style?: unknown }) => {
    captured.style = props.style;
    return null;
  },
}));

afterEach(() => vi.unstubAllGlobals());

describe("ContextMenuTrigger", () => {
  it("preserves a static trigger style so the native press highlight can inherit its corners", () => {
    vi.stubGlobal("React", React);
    const rowStyle = [{ borderRadius: 8 }, { backgroundColor: "#111" }];

    renderToStaticMarkup(<ContextMenuTrigger style={rowStyle} />);

    expect(captured.style).toBe(rowStyle);
  });
});
