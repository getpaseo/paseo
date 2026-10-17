import { describe, expect, it } from "vitest";

const { configureMainActivity } = require("./app.plugin");

const TEMPLATE = `package sh.paseo

import android.os.Bundle
import com.facebook.react.ReactActivity

class MainActivity : ReactActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(null)
  }
}
`;

describe("Android hardware keyboard MainActivity interception", () => {
  it("dispatches key events to the hardware keyboard module before the view hierarchy", () => {
    const result = configureMainActivity(TEMPLATE, "kt");
    expect(result).toBe(`package sh.paseo

import android.os.Bundle
import com.facebook.react.ReactActivity

class MainActivity : ReactActivity() {
  // Hardware keyboard Enter reaches the composer's Enter rules before ReactEditText.
  override fun dispatchKeyEvent(event: android.view.KeyEvent): Boolean {
    if (sh.paseo.hardwarekeyboard.PaseoHardwareKeyboardDispatcher.dispatchKeyEvent(this, event)) return true
    return super.dispatchKeyEvent(event)
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(null)
  }
}
`);
  });

  it("is idempotent across repeated prebuilds", () => {
    const once = configureMainActivity(TEMPLATE, "kt");
    expect(configureMainActivity(once, "kt")).toBe(once);
  });

  it("fails prebuild instead of silently skipping interception", () => {
    expect(() => configureMainActivity(TEMPLATE, "java")).toThrow("MainActivity is not Kotlin");
    expect(() => configureMainActivity("class Other : Activity() {\n}", "kt")).toThrow(
      "MainActivity template changed",
    );
    const withOverride = TEMPLATE.replace(
      "  override fun onCreate",
      "  override fun dispatchKeyEvent(event: KeyEvent): Boolean = true\n  override fun onCreate",
    );
    expect(() => configureMainActivity(withOverride, "kt")).toThrow(
      "already overrides dispatchKeyEvent",
    );
  });
});
