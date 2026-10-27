import { describe, expect, test } from "vitest";
import { BrowserAutomationHostCapabilitySchema } from "./capabilities.js";

describe("browser upload selector capability", () => {
  test("older hosts do not advertise selector uploads", () => {
    const host = BrowserAutomationHostCapabilitySchema.parse({ supportedCommands: ["upload"] });
    expect(host.uploadBySelector).toBeUndefined();
  });

  test("capable hosts explicitly advertise selector uploads", () => {
    const host = BrowserAutomationHostCapabilitySchema.parse({
      supportedCommands: ["upload"],
      uploadBySelector: true,
    });
    expect(host.uploadBySelector).toBe(true);
  });

  test("invalid selector capabilities are rejected", () => {
    expect(
      BrowserAutomationHostCapabilitySchema.safeParse({
        supportedCommands: ["upload"],
        uploadBySelector: "true",
      }).success,
    ).toBe(false);
  });
});
