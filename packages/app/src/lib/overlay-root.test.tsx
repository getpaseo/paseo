// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dispatchTopWebOverlayKeyDown,
  hasActiveWebOverlay,
  useWebOverlayRegistration,
} from "./overlay-root";

describe("useWebOverlayRegistration", () => {
  let opener: HTMLButtonElement;
  let input: HTMLInputElement;
  let scope: HTMLDivElement;

  beforeEach(() => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 0;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});

    opener = document.createElement("button");
    input = document.createElement("input");
    scope = document.createElement("div");
    scope.tabIndex = -1;
    scope.append(input);
    document.body.append(opener, scope);
    opener.focus();
    expect(document.activeElement).toBe(opener);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it("does not restore opener focus when an active overlay scope detaches", () => {
    const { result, unmount } = renderHook(() =>
      useWebOverlayRegistration({ active: true, layer: 20, onKeyDown: () => false }),
    );

    act(() => result.current(scope));
    const openerFocus = vi.spyOn(opener, "focus");
    input.focus();
    expect(document.activeElement).toBe(input);

    act(() => result.current(null));

    expect(openerFocus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
    unmount();
  });

  it("restores opener focus when an overlay closes", () => {
    const { result, rerender, unmount } = renderHook(
      ({ active }: { active: boolean }) =>
        useWebOverlayRegistration({ active, layer: 20, onKeyDown: () => false }),
      { initialProps: { active: true } },
    );

    act(() => result.current(scope));
    const openerFocus = vi.spyOn(opener, "focus");
    input.focus();
    expect(document.activeElement).toBe(input);

    act(() => rerender({ active: false }));

    expect(openerFocus).toHaveBeenCalled();
    unmount();
  });

  it("restores opener focus when an active overlay unmounts after its scope detaches", () => {
    const { result, unmount } = renderHook(() =>
      useWebOverlayRegistration({ active: true, layer: 20, onKeyDown: () => false }),
    );

    act(() => result.current(scope));
    const openerFocus = vi.spyOn(opener, "focus");
    input.focus();
    expect(document.activeElement).toBe(input);

    act(() => result.current(null));
    expect(openerFocus).not.toHaveBeenCalled();

    unmount();

    expect(openerFocus).toHaveBeenCalled();
  });

  it("lets a passive overlay answer keys without counting as an open overlay", () => {
    const onKeyDown = vi.fn((event: KeyboardEvent) => event.key === "Escape");
    const { result, unmount } = renderHook(() =>
      useWebOverlayRegistration({
        active: true,
        layer: 10,
        onKeyDown,
        manageFocus: false,
        passive: true,
      }),
    );

    act(() => result.current(scope));

    expect(hasActiveWebOverlay()).toBe(false);
    expect(dispatchTopWebOverlayKeyDown(new KeyboardEvent("keydown", { key: "Escape" }))).toBe(
      true,
    );
    expect(dispatchTopWebOverlayKeyDown(new KeyboardEvent("keydown", { key: "f" }))).toBe(false);
    expect(onKeyDown).toHaveBeenCalledTimes(2);
    unmount();
  });

  it("keeps keys with an open overlay when a passive one registers after it", () => {
    const menuKeyDown = vi.fn(() => true);
    const passiveKeyDown = vi.fn(() => true);
    const menu = renderHook(() =>
      useWebOverlayRegistration({
        active: true,
        layer: 10,
        onKeyDown: menuKeyDown,
        manageFocus: false,
      }),
    );
    act(() => menu.result.current(scope));
    const passive = renderHook(() =>
      useWebOverlayRegistration({
        active: true,
        layer: 10,
        onKeyDown: passiveKeyDown,
        manageFocus: false,
        passive: true,
      }),
    );
    act(() => passive.result.current(scope));

    expect(dispatchTopWebOverlayKeyDown(new KeyboardEvent("keydown", { key: "Escape" }))).toBe(
      true,
    );
    expect(menuKeyDown).toHaveBeenCalledTimes(1);
    expect(passiveKeyDown).not.toHaveBeenCalled();
    passive.unmount();
    menu.unmount();
  });

  it("leaves IME composition keys with the focused editor", () => {
    const event = new KeyboardEvent("keydown", { key: "Process", bubbles: true });
    expect(dispatchTopWebOverlayKeyDown(event)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
  });
});
