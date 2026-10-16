import { beforeAll, describe, expect, it, vi } from "vitest";

const { configure } = vi.hoisted(() => ({
  configure: vi.fn<(config: { breakpoints: Record<string, number> }) => void>(),
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: { configure },
  useUnistyles: vi.fn(),
}));
vi.mock("./theme", () => ({ REGISTERED_THEMES: {} }));

import { isCompactBreakpoint } from "@/constants/layout";

describe("responsive form factor", () => {
  beforeAll(async () => {
    await import("./unistyles");
  });

  it.each([
    { width: 393, compact: true },
    { width: 599, compact: true },
    { width: 600, compact: false },
    { width: 698, compact: false },
    { width: 720, compact: false },
    { width: 800, compact: false },
  ])("uses the expected form factor at $width dp", ({ width, compact }) => {
    const { breakpoints } = configure.mock.calls[0][0];
    const breakpoint = Object.entries(breakpoints).findLast(([, minimum]) => width >= minimum);

    expect(breakpoint).toBeDefined();
    expect(isCompactBreakpoint(breakpoint?.[0])).toBe(compact);
  });
});
