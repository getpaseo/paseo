import { describe, expect, it } from "vitest";
import { parseCliShimResult } from "./managed-runtime";

describe("parseCliShimResult", () => {
  it("parses manual install payloads from the desktop backend", () => {
    expect(
      parseCliShimResult({
        status: "manualInstallRequired",
        installed: false,
        path: "/usr/local/bin/paseo",
        message: "Install it manually.",
        manualInstructions: {
          title: "Install from Terminal",
          detail: "Run these commands.",
          commands: "sudo tee /usr/local/bin/paseo",
        },
      })
    ).toEqual({
      status: "manualInstallRequired",
      installed: false,
      path: "/usr/local/bin/paseo",
      message: "Install it manually.",
      manualInstructions: {
        title: "Install from Terminal",
        detail: "Run these commands.",
        commands: "sudo tee /usr/local/bin/paseo",
      },
    });
  });

  it("falls back to installed or removed when older payloads omit status", () => {
    expect(
      parseCliShimResult({
        installed: true,
        path: "/usr/local/bin/paseo",
        message: "Installed.",
      })
    ).toEqual({
      status: "installed",
      installed: true,
      path: "/usr/local/bin/paseo",
      message: "Installed.",
      manualInstructions: null,
    });
  });
});
