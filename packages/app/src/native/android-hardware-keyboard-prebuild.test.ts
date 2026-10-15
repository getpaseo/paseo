import { describe, expect, it } from "vitest";

const {
  configureHardwareKeyboardActivity,
} = require("../../plugins/with-android-hardware-keyboard");

describe("Android hardware keyboard prebuild", () => {
  const source = "package sh.paseo\nclass MainActivity : ReactActivity() {\n}\n";

  it("installs the native-to-JS event handler inside MainActivity exactly once", () => {
    const configured = configureHardwareKeyboardActivity(source);
    expect(configured).toContain('context.emitDeviceEvent("paseoHardwareKeyboardSubmit")');
    expect(configured.trimEnd().endsWith("}\n}")).toBe(true);
    expect(configureHardwareKeyboardActivity(configured)).toBe(configured);
  });

  it("limits interception to physical, unmodified composer Enter without IME composition", () => {
    const configured = configureHardwareKeyboardActivity(source);
    for (const guard of [
      "KEYCODE_ENTER",
      "KEYCODE_NUMPAD_ENTER",
      "FLAG_SOFT_KEYBOARD",
      "event.deviceId <= 0",
      "event.hasNoModifiers()",
      "event.repeatCount != 0",
      "getComposingSpanStart(input.text)",
      '== "message-input-root"',
      "ACTION_UP && paseoEnterConsumed",
    ])
      expect(configured).toContain(guard);
  });

  it("fails explicitly if the generated activity shape changes", () => {
    expect(() => configureHardwareKeyboardActivity("class OtherActivity {}")).toThrow();
    expect(() =>
      configureHardwareKeyboardActivity(
        "class MainActivity { override fun dispatchKeyEvent(event: KeyEvent) = true }",
      ),
    ).toThrow("already overrides");
  });
});
