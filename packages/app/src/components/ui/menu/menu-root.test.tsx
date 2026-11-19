/**
 * @vitest-environment jsdom
 */
import React, { createRef } from "react";
import { fireEvent, render } from "@testing-library/react";
import { Text, type View } from "react-native";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MenuRoot, MenuTrigger } from "./menu-root";

beforeEach(() => vi.stubGlobal("React", React));

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

  it("invokes an onPress prop while toggling the menu", () => {
    const onPress = vi.fn();
    const onOpenChange = vi.fn();

    const { getByTestId } = render(
      <MenuRoot onOpenChange={onOpenChange}>
        <MenuTrigger testID="trigger" accessibilityLabel="Open menu" onPress={onPress}>
          <Text>Open</Text>
        </MenuTrigger>
      </MenuRoot>,
    );

    fireEvent.click(getByTestId("trigger"));

    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });
});
