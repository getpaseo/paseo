import { expect, it } from "vitest";
import { describeSandbox } from "./sandbox";

it("reports a portable fallback independently of the renderer's Node isolation setting", () => {
  expect(
    describeSandbox({
      disabled: true,
      launcherReason: "user namespaces unavailable; no usable SUID helper",
    }),
  ).toEqual({
    enabled: false,
    reason: "user namespaces unavailable; no usable SUID helper",
  });
});

it("reports enabled defaults and explicit overrides without a packaged launcher", () => {
  expect(describeSandbox({ disabled: false })).toEqual({
    enabled: true,
    reason: "Chromium default",
  });
  expect(describeSandbox({ disabled: true })).toEqual({
    enabled: false,
    reason: "requested by --no-sandbox",
  });
});
