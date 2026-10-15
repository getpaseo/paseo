import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const {
  configureHardwareKeyboardActivity,
} = require("../../plugins/with-android-hardware-keyboard");

describe("Android hardware keyboard prebuild", () => {
  const source = "package sh.paseo\nclass MainActivity : ReactActivity() {\n}\n";

  it("marks the native input itself instead of relying on composer ancestry", () => {
    const input = readFileSync(path.resolve(__dirname, "../composer/input/input.tsx"), "utf8");
    const patch = readFileSync(
      path.resolve(
        __dirname,
        "../../../../patches/@mattermost+react-native-paste-input+2.0.1.patch",
      ),
      "utf8",
    );
    expect(input).toContain('testID="paseo-composer-input"');
    expect(patch).toContain(
      'if (getTag(com.facebook.react.R.id.react_test_id) == "paseo-composer-input")',
    );
    expect(configureHardwareKeyboardActivity(source)).not.toContain("ancestor.parent");
    expect(patch).not.toContain("+    var ancestor:");
  });

  it("patches the composer input before the IME can consume Enter, including device zero", () => {
    const patch = readFileSync(
      path.resolve(
        __dirname,
        "../../../../patches/@mattermost+react-native-paste-input+2.0.1.patch",
      ),
      "utf8",
    );
    expect(patch).toContain("override fun onKeyPreIme");
    expect(patch).toContain("event.deviceId < 0");
    expect(patch).toContain("getComposingSpanStart(text) >= 0");
    expect(patch).toContain("!event.hasNoModifiers()");
    expect(patch).toContain("ACTION_UP && paseoPreImeEnterConsumed");
    expect(patch).toContain('emitDeviceEvent("paseoHardwareKeyboardSubmit")');
  });

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
      'input.getTag(com.facebook.react.R.id.react_test_id) == "paseo-composer-input"',
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
