/* oxlint-disable import/no-unassigned-import -- Exercise the actual GPUI Intl implementation. */
import "@formatjs/intl-datetimeformat/polyfill-force.js";
import "@formatjs/intl-datetimeformat/locale-data/en.js";
import "@formatjs/intl-datetimeformat/add-all-tz.js";
import { afterEach, expect, test } from "vitest";
import { setDefaultTimeZone } from "./intl-timezone";

afterEach(() => setDefaultTimeZone("UTC"));

test.each([
  ["GMT", "UTC"],
  ["gmt", "UTC"],
  ["UTC", "UTC"],
  ["Europe/Berlin", "Europe/Berlin"],
  ["US/Pacific", "America/Los_Angeles"],
])("initializes the system timezone %s as %s", (systemZone, expectedZone) => {
  setDefaultTimeZone(systemZone);
  expect(new Intl.DateTimeFormat("en").resolvedOptions().timeZone).toBe(expectedZone);
});

test("does not silently replace an invalid system timezone", () => {
  expect(() => setDefaultTimeZone("Invalid/Zone")).toThrow(RangeError);
});
