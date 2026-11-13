import { describe, expect, it } from "vitest";
import { APP_BREAKPOINTS } from "./breakpoints";
import { isCompactBreakpoint } from "@/constants/layout";

describe("responsive form factor", () => {
  it.each([
    { width: 393, compact: true },
    { width: 599, compact: true },
    { width: 600, compact: false },
    { width: 698, compact: false },
    { width: 720, compact: false },
    { width: 800, compact: false },
  ])("uses the expected form factor at $width dp", ({ width, compact }) => {
    const breakpoint = Object.entries(APP_BREAKPOINTS).findLast(([, minimum]) => width >= minimum);

    expect(breakpoint).toBeDefined();
    expect(isCompactBreakpoint(breakpoint?.[0])).toBe(compact);
  });
});
