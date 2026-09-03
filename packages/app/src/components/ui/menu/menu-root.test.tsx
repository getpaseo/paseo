/**
 * @vitest-environment jsdom
 */
import React, { createRef } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { Text, type View } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MenuRoot, MenuTrigger } from "./menu-root";

vi.mock("@/constants/layout", () => ({ useIsCompactFormFactor: () => false }));

beforeEach(() => vi.stubGlobal("React", React));
afterEach(cleanup);

describe("MenuTrigger", () => {
  it("forwards its rendered trigger to callers", () => {
    const triggerRef = createRef<View>();

    render(
      <MenuRoot>
        <MenuTrigger ref={triggerRef} accessibilityLabel="Open menu">
          <Text>Open</Text>
        </MenuTrigger>
      </MenuRoot>,
    );

    expect(triggerRef.current).not.toBeNull();
  });

  it("owns presses when nested inside another pressable", () => {
    const onParentPress = vi.fn();
    const { getByLabelText } = render(
      <div onClick={onParentPress}>
        <MenuRoot>
          <MenuTrigger accessibilityLabel="Open menu">
            <Text>Open</Text>
          </MenuTrigger>
        </MenuRoot>
      </div>,
    );

    fireEvent.click(getByLabelText("Open menu"));

    expect(onParentPress).not.toHaveBeenCalled();
  });
});
