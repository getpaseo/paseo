/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { usePluginButtonMenuOpen } from "./menu-open";

const action = { kind: "action" as const, onPress() {} };

function button(
  behavior: { kind: "action"; onPress(): void } = action,
  patch: { visible?: boolean; disabled?: boolean } = {},
) {
  return {
    visible: patch.visible ?? true,
    disabled: patch.disabled ?? false,
    behavior,
  };
}

describe("usePluginButtonMenuOpen", () => {
  it("keeps each rendered button open on its own", () => {
    const shared = button();
    const first = renderHook(() => usePluginButtonMenuOpen(shared));
    const second = renderHook(() => usePluginButtonMenuOpen(shared));
    act(() => {
      first.result.current[1](true);
    });
    expect(first.result.current[0]).toBe(true);
    expect(second.result.current[0]).toBe(false);
  });

  it("closes when the behavior is replaced or the button cannot open", () => {
    const initial = action;
    interface Props {
      behavior: typeof action;
      visible?: boolean;
      disabled?: boolean;
    }
    const hook = renderHook<ReturnType<typeof usePluginButtonMenuOpen>, Props>(
      (props) => usePluginButtonMenuOpen(button(props.behavior, props)),
      { initialProps: { behavior: initial } },
    );
    act(() => {
      hook.result.current[1](true);
    });
    const replaced = { kind: "action" as const, onPress() {} };
    hook.rerender({ behavior: replaced });
    expect(hook.result.current[0]).toBe(false);

    act(() => {
      hook.result.current[1](true);
    });
    hook.rerender({ behavior: replaced, visible: false });
    expect(hook.result.current[0]).toBe(false);
  });

  it("stays open when the same button object is republished", () => {
    const stable = button();
    const hook = renderHook(
      (props: { button: ReturnType<typeof button> }) => usePluginButtonMenuOpen(props.button),
      { initialProps: { button: stable } },
    );
    act(() => {
      hook.result.current[1](true);
    });
    hook.rerender({ button: stable });
    expect(hook.result.current[0]).toBe(true);
  });
});
