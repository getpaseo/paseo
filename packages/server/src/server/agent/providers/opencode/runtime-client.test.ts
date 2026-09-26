import { expect, test } from "vitest";
import { openCodeMajorVersion } from "./runtime-client.js";

test.each([
  ["1.14.46", 1],
  ["opencode v2.0.10\n", 2],
  ["v2.0.10-beta.1", 2],
])("identifies the OpenCode runtime version %s", (output, major) => {
  expect(openCodeMajorVersion(String(output))).toBe(major);
});

test.each(["3.0.0", "2.0.9", "2.0.7", "2.0.4", "2.0.3", "v2.0.1", "unexpected wrapper output", ""])(
  "rejects unsupported OpenCode version output %s",
  (output) => {
    expect(() => openCodeMajorVersion(output)).toThrow();
  },
);
