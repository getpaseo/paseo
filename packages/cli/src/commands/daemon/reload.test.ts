import { describe, expect, test } from "vitest";
import { render } from "../../output/render.js";
import { daemonReloadSchema, type DaemonReloadResult } from "./reload.js";

function result(data: DaemonReloadResult) {
  return { type: "single" as const, data, schema: daemonReloadSchema };
}

describe("daemon reload output", () => {
  test("human output reports restart and override warnings", () => {
    expect(
      render(
        result({
          appliedPaths: ["daemon.browserTools.enabled"],
          restartRequiredPaths: ["daemon.listen"],
          overrideControlledPaths: ["app.baseUrl"],
        }),
      ),
    ).toBe(
      [
        "Configuration reloaded.",
        "",
        "Warning: These changes require a daemon restart:",
        "  daemon.listen",
        "",
        "Run: paseo daemon restart",
        "",
        "Warning: These settings are controlled by daemon launch overrides:",
        "  app.baseUrl",
      ].join("\n"),
    );
  });

  test("human output omits restart guidance for a live-only reload", () => {
    const output = render(
      result({
        appliedPaths: ["daemon.browserTools.enabled"],
        restartRequiredPaths: [],
        overrideControlledPaths: [],
      }),
    );
    expect(output).toBe("Configuration reloaded.");
    expect(output).not.toContain("restart");
  });

  test("structured output preserves the daemon result", () => {
    const data = {
      appliedPaths: ["daemon.browserTools.enabled"],
      restartRequiredPaths: ["daemon.listen"],
      overrideControlledPaths: [],
    };
    expect(render(result(data), { format: "json" })).toBe(JSON.stringify(data, null, 2));
    expect(render(result(data), { format: "yaml" })).toContain(
      "appliedPaths:\n  - daemon.browserTools.enabled",
    );
  });
});
