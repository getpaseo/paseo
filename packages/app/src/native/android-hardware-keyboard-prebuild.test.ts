import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
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

  it("executes the production Kotlin handlers against typed Android editing adapters", () => {
    const patch = readFileSync(
      path.resolve(
        __dirname,
        "../../../../patches/@mattermost+react-native-paste-input+2.0.1.patch",
      ),
      "utf8",
    );
    const preIme = patch
      .split("\n")
      .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
      .map((line) => line.slice(1))
      .join("\n");
    const start = preIme.indexOf("  private var paseoPreImeEnterConsumed");
    const end = preIme.indexOf("  override fun onCreateInputConnection", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const activity = configureHardwareKeyboardActivity(source);
    const activityBody = activity.slice(
      activity.indexOf("  // Physical Enter"),
      activity.lastIndexOf("}"),
    );
    const handlers = `class ComposerInput : ReactEditText() {\n${preIme.slice(start, end)}\n}\nclass HardwareActivity : ActivityAdapter() {\n${activityBody}\n}`;
    // Only adapt framework type names. Execute the actual Kotlin branches,
    // state, superclass delegation and event emission, not a JS reimplementation.
    const adapted = handlers
      .replaceAll("android.view.KeyEvent", "KeyEvent")
      .replaceAll("android.view.inputmethod.BaseInputConnection", "BaseInputConnection")
      .replaceAll("com.facebook.react.views.textinput.ReactEditText", "ReactEditText")
      .replaceAll("com.facebook.react.bridge.ReactContext", "ReactContext")
      .replaceAll("com.facebook.react.R", "R");
    const harness = readFileSync(
      path.join(__dirname, "test-support/HardwareKeyboardHarness.kt"),
      "utf8",
    );
    const directory = mkdtempSync(path.join(tmpdir(), "paseo-keyboard-"));
    try {
      const kotlin = path.join(directory, "HardwareKeyboardHarness.kt");
      const jar = path.join(directory, "keyboard.jar");
      const run = (implementation: string) => {
        writeFileSync(kotlin, harness.replace("// HANDLERS", implementation));
        execFileSync("kotlinc", [kotlin, "-include-runtime", "-d", jar], { timeout: 45000 });
        return spawnSync("java", ["-jar", jar], { encoding: "utf8", timeout: 10000 });
      };
      const result = run(adapted);
      expect(result.status).toBe(0);
      expect(result.stdout.trim().split("\n")).toHaveLength(14);
      expect(result.stdout).toContain("PASS Activity fallback submits once");

      // Prove that these behavioral checks reject precisely the regressions
      // identified by review, even though all guard/emission strings still exist.
      const invertedGuard = run(
        adapted.replaceAll("!event.hasNoModifiers()", "event.hasNoModifiers()"),
      );
      expect(invertedGuard.status).toBe(1);
      expect(invertedGuard.stderr).toContain("IllegalStateException: Check failed");
      const doubleEmission = run(
        adapted.replaceAll(
          '.emitDeviceEvent("paseoHardwareKeyboardSubmit")',
          '.apply { emitDeviceEvent("paseoHardwareKeyboardSubmit"); emitDeviceEvent("paseoHardwareKeyboardSubmit") }',
        ),
      );
      expect(doubleEmission.status).toBe(1);
      expect(doubleEmission.stderr).toContain("IllegalStateException: Check failed");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 180000);

  it("installs the native-to-JS event handler inside MainActivity exactly once", () => {
    const configured = configureHardwareKeyboardActivity(source);
    expect(configured).toContain('context.emitDeviceEvent("paseoHardwareKeyboardSubmit")');
    expect(configured.trimEnd().endsWith("}\n}")).toBe(true);
    expect(configureHardwareKeyboardActivity(configured)).toBe(configured);
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
