import { describe, expect, it } from "vitest";
import { redactModelFacingText, redactModelFacingValue } from "./model-facing-redaction.js";

describe("model-facing redaction", () => {
  it("redacts nested credential fields without hiding ordinary arguments", () => {
    expect(
      redactModelFacingValue({
        command: "deploy",
        headers: { Authorization: "Bearer sentinel-bearer" },
        env: { API_KEY: "sentinel-key", PATH: "/bin" },
      }),
    ).toEqual({
      command: "deploy",
      headers: { Authorization: "[redacted]" },
      env: { API_KEY: "[redacted]", PATH: "/bin" },
    });
  });

  it("redacts credentials embedded in prose and URLs", () => {
    const result = redactModelFacingText(
      "Bearer sentinel-bearer https://user:sentinel-password@example.test",
    );
    expect(result).not.toContain("sentinel-bearer");
    expect(result).not.toContain("sentinel-password");
  });
});
