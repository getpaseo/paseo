import React, { act, useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Pressable, Text, View } from "react-native";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";
import { ReducedMotionConfig, ReduceMotion } from "react-native-reanimated";
import { Combobox, ComboboxItem, type ComboboxProps } from "./combobox";
import { ComposerTrackRow } from "@/composer/tracks";
import { MenuRoot, MenuTrigger, MenuSurface, MenuItem, MenuSubTrigger } from "./menu";
import { Tooltip, TooltipTrigger } from "./tooltip";

const behindStyle = { position: "fixed" as const, left: 600, top: 400 };

let root: Root;
let container: HTMLDivElement;

beforeEach(async () => {
  await page.viewport(1000, 800);
  vi.stubGlobal("React", React);
  container = document.createElement("div");
  container.style.cssText = "position:absolute;left:100px;top:100px;width:240px";
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await mouse("mouseReleased", 10, 10);
  act(() => root.unmount());
  container.remove();
});

function mount(content: ReactNode) {
  act(() =>
    root.render(
      <>
        <ReducedMotionConfig mode={ReduceMotion.Always} />
        {content}
      </>,
    ),
  );
}

function element(id: string): HTMLElement {
  const node = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (!node) throw new Error(`Missing ${id}`);
  return node;
}

async function mouse(type: "mousePressed" | "mouseMoved" | "mouseReleased", x: number, y: number) {
  const frame = window.frameElement?.getBoundingClientRect();
  await cdp().send("Input.dispatchMouseEvent", {
    type,
    x: x * (frame ? frame.width / window.innerWidth : 1) + (frame?.left ?? 0),
    y: y * (frame ? frame.height / window.innerHeight : 1) + (frame?.top ?? 0),
    button: "left",
    buttons: type === "mouseReleased" ? 0 : 1,
    clickCount: type === "mouseMoved" ? 0 : 1,
  });
}

async function point(type: "mousePressed" | "mouseMoved" | "mouseReleased", id: string) {
  const rect = element(id).getBoundingClientRect();
  await mouse(type, rect.left + rect.width / 2, rect.top + rect.height / 2);
}

it("opens before mouseup and selects the option under the held pointer exactly once", async () => {
  const select = vi.fn();
  mount(
    <MenuRoot>
      <MenuTrigger testID="trigger">
        <Text>Actions</Text>
      </MenuTrigger>
      <MenuSurface testID="surface" width={240}>
        <MenuItem testID="option" onSelect={select}>
          Choose
        </MenuItem>
      </MenuSurface>
    </MenuRoot>,
  );
  await point("mousePressed", "trigger");
  await expect.poll(() => element("trigger").getAttribute("aria-expanded")).toBe("true");
  await expect.poll(() => element("option").getBoundingClientRect().left).toBeGreaterThan(90);
  await point("mouseMoved", "option");
  expect(select).not.toHaveBeenCalled();
  await point("mouseReleased", "option");
  await expect.poll(() => select.mock.calls.length).toBe(1);
  expect(element("trigger").getAttribute("aria-expanded")).toBe("false");
});

function MenuFixture({ select, keepOpen = false }: { select: () => void; keepOpen?: boolean }) {
  return (
    <MenuRoot>
      <MenuTrigger testID="trigger">
        <Text>Actions</Text>
      </MenuTrigger>
      <MenuSurface
        testID="surface"
        width={240}
        pages={[
          {
            id: "sub",
            title: "More",
            content: (
              <MenuItem testID="nested" onSelect={select}>
                Nested choice
              </MenuItem>
            ),
          },
        ]}
      >
        <MenuItem testID="option" closeOnSelect={!keepOpen} onSelect={select}>
          Choose
        </MenuItem>
        <MenuItem testID="disabled" disabled onSelect={select}>
          Unavailable
        </MenuItem>
        <MenuSubTrigger id="sub" testID="sub">
          More
        </MenuSubTrigger>
        <ComposerTrackRow testID="custom" onPress={select}>
          <Text>Custom row</Text>
          <Pressable testID="secondary" accessibilityRole="button" onPress={select}>
            <Text>Secondary action</Text>
          </Pressable>
        </ComposerTrackRow>
      </MenuSurface>
    </MenuRoot>
  );
}

it("dismisses the trigger tooltip as soon as the held gesture opens the menu", async () => {
  const tooltipOpenChange = vi.fn();
  const select = vi.fn();
  mount(
    <MenuRoot>
      <Tooltip defaultOpen onOpenChange={tooltipOpenChange}>
        <TooltipTrigger asChild>
          <MenuTrigger testID="trigger">
            <Text>Actions</Text>
          </MenuTrigger>
        </TooltipTrigger>
      </Tooltip>
      <MenuSurface testID="surface" width={240}>
        <MenuItem testID="option" onSelect={select}>
          Choose
        </MenuItem>
      </MenuSurface>
    </MenuRoot>,
  );
  await openHeld();
  expect(tooltipOpenChange).toHaveBeenCalledWith(false);
  expect(element("trigger").getAttribute("aria-expanded")).toBe("true");
});

async function openHeld() {
  await point("mousePressed", "trigger");
  await expect.poll(() => element("option").getBoundingClientRect().left).toBeGreaterThan(90);
}

it("keeps a plain click open and closes on the next trigger press", async () => {
  const select = vi.fn();
  mount(<MenuFixture select={select} />);
  await openHeld();
  await point("mouseReleased", "trigger");
  expect(element("trigger").getAttribute("aria-expanded")).toBe("true");
  await point("mousePressed", "trigger");
  expect(element("trigger").getAttribute("aria-expanded")).toBe("false");
  await point("mouseReleased", "trigger");
  expect(element("trigger").getAttribute("aria-expanded")).toBe("false");
  expect(select).not.toHaveBeenCalled();
});

it("leaves disabled rows and secondary buttons alone", async () => {
  const select = vi.fn();
  mount(<MenuFixture select={select} />);
  await openHeld();
  await point("mouseMoved", "disabled");
  await point("mouseReleased", "disabled");
  expect(element("trigger").getAttribute("aria-expanded")).toBe("true");
  expect(select).not.toHaveBeenCalled();
  // Close and reopen to start another held gesture.
  await point("mousePressed", "trigger");
  await point("mouseReleased", "trigger");
  await openHeld();
  await point("mouseMoved", "secondary");
  await point("mouseReleased", "secondary");
  expect(select).not.toHaveBeenCalled();
  expect(element("trigger").getAttribute("aria-expanded")).toBe("true");
});

it("cancels outside without clicking the content behind the backdrop", async () => {
  const select = vi.fn();
  mount(
    <>
      <button type="button" data-testid="behind" style={behindStyle} onClick={select}>
        Behind
      </button>
      <MenuFixture select={select} />
    </>,
  );
  await openHeld();
  await point("mouseMoved", "behind");
  await point("mouseReleased", "behind");
  expect(element("trigger").getAttribute("aria-expanded")).toBe("false");
  expect(select).not.toHaveBeenCalled();
});

it("selects custom rows and preserves keep-open selections", async () => {
  const select = vi.fn();
  mount(<MenuFixture select={select} keepOpen />);
  await openHeld();
  await point("mouseMoved", "option");
  await point("mouseReleased", "option");
  expect(select).toHaveBeenCalledTimes(1);
  expect(element("trigger").getAttribute("aria-expanded")).toBe("true");
  await point("mousePressed", "trigger");
  await point("mouseReleased", "trigger");
  await openHeld();
  const rect = element("custom").getBoundingClientRect();
  await mouse("mouseMoved", rect.left + 10, rect.top + 10);
  await mouse("mouseReleased", rect.left + 10, rect.top + 10);
  expect(select).toHaveBeenCalledTimes(2);
  expect(element("trigger").getAttribute("aria-expanded")).toBe("false");
});

it("opens a submenu while held and selects inside its portal", async () => {
  const select = vi.fn();
  mount(<MenuFixture select={select} />);
  await openHeld();
  await point("mouseMoved", "sub");
  await expect.poll(() => element("nested").getBoundingClientRect().top).toBeGreaterThan(0);
  await point("mouseMoved", "nested");
  await point("mouseReleased", "nested");
  expect(select).toHaveBeenCalledTimes(1);
});

function PickerFixture({
  select,
  custom = false,
  keepOpen = false,
  disabled = false,
  disabledOption = false,
}: {
  select: (id: string) => void;
  custom?: boolean;
  keepOpen?: boolean;
  disabled?: boolean;
  disabledOption?: boolean;
}) {
  const anchorRef = useRef<View>(null);
  const [open, setOpen] = useState(false);
  const handlePress = useCallback(() => setOpen((value) => !value), []);
  const accessibilityState = useMemo(() => ({ expanded: open }), [open]);
  const renderOption = useCallback<NonNullable<ComboboxProps["renderOption"]>>(
    ({ option, onPress, active }) =>
      custom ? (
        <Pressable
          testID={option.id === "one" ? "option" : "two"}
          onPress={onPress}
          accessibilityRole="button"
        >
          <Text>
            {option.label} {active ? "hovered" : ""}
          </Text>
        </Pressable>
      ) : (
        <ComboboxItem
          testID={option.id === "one" ? "option" : "two"}
          label={option.label}
          disabled={disabledOption}
          onPress={onPress}
          active={active}
        />
      ),
    [custom, disabledOption],
  );
  return (
    <>
      <View ref={anchorRef}>
        <Pressable
          disabled={disabled}
          testID="trigger"
          onPress={handlePress}
          accessibilityState={accessibilityState}
        >
          <Text>Picker</Text>
        </Pressable>
      </View>
      <Combobox
        anchorRef={anchorRef}
        open={open}
        onOpenChange={setOpen}
        value=""
        options={[
          { id: "one", label: "One" },
          { id: "two", label: "Two" },
        ]}
        onSelect={select}
        keepOpenOnSelect={keepOpen}
        renderOption={renderOption}
      />
    </>
  );
}

it.each([false, true])(
  "selects combobox options (custom=%s) without focusing search during the gesture",
  async (custom) => {
    const select = vi.fn();
    mount(<PickerFixture select={select} custom={custom} />);
    await openHeld();
    expect(document.activeElement?.tagName).not.toBe("INPUT");
    await point("mouseMoved", "option");
    await point("mouseReleased", "option");
    expect(select).toHaveBeenCalledExactlyOnceWith("one");
    expect(document.querySelector('[data-testid="combobox-desktop-container"]')).toBeNull();
  },
);

it("focuses search after a simple click and supports subsequent ordinary selection", async () => {
  const select = vi.fn();
  mount(<PickerFixture select={select} keepOpen />);
  await openHeld();
  await point("mouseReleased", "trigger");
  await expect.poll(() => document.activeElement?.tagName).toBe("INPUT");
  await point("mousePressed", "option");
  await point("mouseReleased", "option");
  expect(select).toHaveBeenCalledExactlyOnceWith("one");
  expect(document.querySelector('[data-testid="combobox-desktop-container"]')).not.toBeNull();
});

it("does not open a disabled picker through its anchor wrapper", async () => {
  mount(<PickerFixture select={vi.fn()} disabled />);
  await point("mousePressed", "trigger");
  expect(document.querySelector('[data-testid="combobox-desktop-container"]')).toBeNull();
  await point("mouseReleased", "trigger");
});

it("does not accidentally select during a quick click before positioning settles", async () => {
  const select = vi.fn();
  mount(<PickerFixture select={select} />);
  await point("mousePressed", "trigger");
  await point("mouseReleased", "trigger");
  expect(select).not.toHaveBeenCalled();
  await expect.poll(() => element("option").getBoundingClientRect().left).toBeGreaterThan(90);
});

it("cancels a held selection when the window loses focus", async () => {
  const select = vi.fn();
  mount(<MenuFixture select={select} />);
  await openHeld();
  window.dispatchEvent(new Event("blur"));
  await point("mouseMoved", "option");
  await point("mouseReleased", "option");
  expect(select).not.toHaveBeenCalled();
});

it("preserves keyboard opening and selection", async () => {
  const select = vi.fn();
  mount(<MenuFixture select={select} />);
  element("trigger").focus();
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => document.activeElement?.getAttribute("data-testid")).toBe("option");
  await userEvent.keyboard("{Enter}");
  expect(select).toHaveBeenCalledTimes(1);
});

it("keeps touch opening on release", async () => {
  const select = vi.fn();
  mount(<MenuFixture select={select} />);
  const rect = element("trigger").getBoundingClientRect();
  const frame = window.frameElement?.getBoundingClientRect();
  const x =
    (rect.left + rect.width / 2) * (frame ? frame.width / window.innerWidth : 1) +
    (frame?.left ?? 0);
  const y =
    (rect.top + rect.height / 2) * (frame ? frame.height / window.innerHeight : 1) +
    (frame?.top ?? 0);
  await cdp().send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  expect(element("trigger").getAttribute("aria-expanded")).toBe("false");
  await cdp().send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect.poll(() => element("trigger").getAttribute("aria-expanded")).toBe("true");
  expect(select).not.toHaveBeenCalled();
});

it("cancels on pointercancel and does not leave the next click suppressed", async () => {
  const select = vi.fn();
  mount(<MenuFixture select={select} />);
  let pointerId = 0;
  document.addEventListener(
    "pointerdown",
    (event) => {
      pointerId = event.pointerId;
    },
    { capture: true, once: true },
  );
  await openHeld();
  document.dispatchEvent(new PointerEvent("pointercancel", { pointerId }));
  await point("mouseReleased", "option");
  expect(select).not.toHaveBeenCalled();
  await point("mousePressed", "option");
  await point("mouseReleased", "option");
  expect(select).toHaveBeenCalledTimes(1);
});

it("does not select a disabled custom combobox row through its wrapper padding", async () => {
  const select = vi.fn();
  mount(<PickerFixture select={select} disabledOption />);
  await openHeld();
  const rect = element("option").getBoundingClientRect();
  await mouse("mouseMoved", rect.left + 2, rect.top + 2);
  await mouse("mouseReleased", rect.left + 2, rect.top + 2);
  expect(select).not.toHaveBeenCalled();
  expect(document.querySelector('[data-testid="combobox-desktop-container"]')).not.toBeNull();
});

it("does not intercept a higher overlay above an open dropdown trigger", async () => {
  const select = vi.fn();
  mount(<MenuFixture select={select} />);
  await openHeld();
  await point("mouseReleased", "trigger");
  const upper = document.createElement("button");
  upper.dataset.testid = "upper";
  upper.style.cssText =
    "position:fixed;left:100px;top:100px;width:240px;height:20px;z-index:999999";
  upper.textContent = "Higher overlay";
  upper.addEventListener("click", select);
  document.body.append(upper);
  try {
    await point("mousePressed", "upper");
    expect(element("trigger").getAttribute("aria-expanded")).toBe("true");
    await point("mouseReleased", "upper");
    expect(select).toHaveBeenCalledTimes(1);
  } finally {
    upper.remove();
  }
});
