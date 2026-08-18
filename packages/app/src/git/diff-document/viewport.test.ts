import { describe, expect, it } from "vitest";
import { retainDiffViewport } from "./viewport";

describe("retainDiffViewport", () => {
  it("waits for the first positive layout", () => {
    const initial = { width: 0, height: 0 };

    expect(retainDiffViewport(initial, { width: 0, height: 700 })).toBe(initial);
    expect(retainDiffViewport(initial, { width: 390, height: 0 })).toBe(initial);
    expect(retainDiffViewport(initial, { width: 390, height: 700 })).toEqual({
      width: 390,
      height: 700,
    });
  });

  it("preserves the completed viewport while a retained panel is hidden", () => {
    const visible = { width: 390, height: 700 };

    expect(retainDiffViewport(visible, { width: 0, height: 0 })).toBe(visible);
  });

  it("accepts a real resize and preserves identity for duplicate layouts", () => {
    const current = { width: 390, height: 700 };

    expect(retainDiffViewport(current, current)).toBe(current);
    expect(retainDiffViewport(current, { width: 700, height: 390 })).toEqual({
      width: 700,
      height: 390,
    });
  });
});
