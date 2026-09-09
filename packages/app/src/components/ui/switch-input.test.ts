import { expect, it } from "vitest";
import { pressSwitch, keyDownSwitch } from "./switch-input";

it.each([false, true])("suppresses disabled pointer and Space input: %s", (disabled) => {
  const changes: boolean[] = [];
  const events: string[] = [];
  const input = {
    value: false,
    disabled,
    onValueChange: (value: boolean) => {
      changes.push(value);
    },
  };
  pressSwitch(input, {
    stopPropagation: () => {
      events.push("stopped");
    },
  });
  keyDownSwitch(input, {
    nativeEvent: { code: "Space", key: " " },
    preventDefault: () => {
      events.push("prevented");
    },
  });
  expect(changes).toEqual(disabled ? [] : [true, true]);
  expect(events).toEqual(["stopped", "prevented"]);
});

it.each(["Enter", "a", "Escape"])("leaves %s to the native press responder", (key) => {
  const changes: boolean[] = [];
  keyDownSwitch(
    {
      value: true,
      disabled: false,
      onValueChange: (value) => {
        changes.push(value);
      },
    },
    { nativeEvent: { key } },
  );
  expect(changes).toEqual([]);
});

it("toggles a checked switch off", () => {
  const changes: boolean[] = [];
  keyDownSwitch(
    {
      value: true,
      disabled: false,
      onValueChange: (value) => {
        changes.push(value);
      },
    },
    { nativeEvent: { key: " " } },
  );
  expect(changes).toEqual([false]);
});
