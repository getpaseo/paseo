import { describe, expect, it } from "vitest";

const { configureDisplayMetricsActivity } = require("./app.plugin");

const SYNC = "sh.paseo.displaymetrics.PaseoDisplayMetrics.syncWithWindow(this)";

describe("Android display metrics", () => {
  it("restores the window's density after React Native reads the display", () => {
    const source = "class MainActivity : ReactActivity() {\n}";
    const result = configureDisplayMetricsActivity(source);
    expect(result).toContain(`super.onContentChanged()\n    ${SYNC}`);
    expect(result).toContain(`super.onConfigurationChanged(newConfig)\n    ${SYNC}`);
    expect(configureDisplayMetricsActivity(result)).toBe(result);
  });

  it("fails prebuild when the template no longer has a place for the overrides", () => {
    expect(() => configureDisplayMetricsActivity("changed template")).toThrow(
      "Could not keep React Native text at the window's density",
    );
  });

  it("fails prebuild rather than replace another plugin's configuration handler", () => {
    const source =
      "class MainActivity : ReactActivity() {\n  override fun onConfigurationChanged(newConfig: Configuration) {}\n}";
    expect(() => configureDisplayMetricsActivity(source)).toThrow(
      "Could not keep React Native text at the window's density",
    );
  });
});
