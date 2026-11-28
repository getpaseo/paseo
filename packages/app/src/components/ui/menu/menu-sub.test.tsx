/**
 * @vitest-environment jsdom
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MenuRoot } from "./menu-root";
import { MenuSubTrigger } from "./menu-sub";
import { MenuSurface } from "./menu-surface";

vi.mock("lucide-react-native", async (importOriginal) => {
  const actual = await importOriginal<typeof import("lucide-react-native")>();
  const ReactModule = await import("react");
  const Native = await import("react-native");
  type IconProps = React.ComponentProps<typeof Native.View>;
  const Icon = (props: IconProps) => ReactModule.createElement(Native.View, props);
  return { ...actual, Check: Icon, ChevronRight: Icon };
});

beforeEach(() => vi.stubGlobal("React", React));

describe("MenuSubTrigger", () => {
  it("preserves selected state alongside its submenu arrow", () => {
    render(
      <MenuRoot defaultOpen>
        <MenuSurface>
          <MenuSubTrigger id="selected-page" selected testID="selected-submenu">
            Selected submenu
          </MenuSubTrigger>
          <MenuSubTrigger id="plain-page" selected={false} testID="plain-submenu">
            Plain submenu
          </MenuSubTrigger>
        </MenuSurface>
      </MenuRoot>,
    );

    expect(screen.getByTestId("selected-submenu").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("plain-submenu").getAttribute("aria-checked")).toBe("false");
    expect(screen.getAllByTestId("menu-sub-selected-check")).toHaveLength(1);
  });
});
