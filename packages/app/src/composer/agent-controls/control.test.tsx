/**
 * @vitest-environment jsdom
 */
import React from "react";
import { fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toolbarGlyphsFor } from "@/components/ui/control-geometry";
import { resolveComposerControlPresentation } from "@/composer/agent-controls/layout";
import { ComposerControlLayoutProvider } from "./layout-context";
import { AgentControlTrigger } from "./control";

beforeEach(() => vi.stubGlobal("React", React));

function TestIcon() {
  return null;
}

function ColorProbeIcon({ color }: { color: string }) {
  return <span data-testid="glyph" data-color={color} />;
}

const TOUCH_TOOLBAR_LAYOUT = {
  glyphs: toolbarGlyphsFor("touch"),
  presentation: resolveComposerControlPresentation("full"),
};

function renderTouchToolbarTrigger(showToolbarLabel: boolean) {
  const view = render(
    <ComposerControlLayoutProvider value={TOUCH_TOOLBAR_LAYOUT}>
      <AgentControlTrigger
        icon={ColorProbeIcon}
        surface="toolbar"
        label="Mode"
        value="Full access"
        showToolbarLabel={showToolbarLabel}
        onPress={vi.fn()}
        accessibilityLabel="Select mode"
      />
    </ComposerControlLayoutProvider>,
  );
  const glyph = view.container.querySelector('[data-testid="glyph"]');
  if (!glyph) throw new Error("trigger painted no glyph");
  return glyph.getAttribute("data-color");
}

describe("AgentControlTrigger", () => {
  it("forwards interaction handlers to the rendered trigger", () => {
    const onPointerEnter = vi.fn();
    const onFocus = vi.fn();
    const onPress = vi.fn();
    const view = render(
      <AgentControlTrigger
        icon={TestIcon}
        surface="toolbar"
        label="Mode"
        onPress={onPress}
        onPointerEnter={onPointerEnter}
        onFocus={onFocus}
        accessibilityLabel="Select mode"
      />,
    );
    const trigger = view.getByRole("button", { name: "Select mode" });

    fireEvent.pointerEnter(trigger);
    fireEvent.focus(trigger);

    expect(onPointerEnter).toHaveBeenCalledTimes(1);
    expect(onFocus).toHaveBeenCalledTimes(1);
  });

  it("mutes a touch glyph paired with a label and keeps an icon-only touch glyph foreground", () => {
    // The test theme names its colors so a test can assert them; see test-stubs/react-native-unistyles.
    expect(renderTouchToolbarTrigger(true)).toBe("#666666");
    expect(renderTouchToolbarTrigger(false)).toBe("#111111");
  });
});
