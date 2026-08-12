import { describe, expect, it } from "vitest";

import { formatTokenCount } from "./context-window-meter.utils";

describe("formatTokenCount", () => {
  it("renders counts below a thousand exactly", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(999)).toBe("999");
  });

  it("keeps one decimal below ten thousand", () => {
    // The live turn counter advances in the hundreds; without the decimal it would sit on "1k"
    // through more than a thousand tokens of output and read as frozen.
    expect(formatTokenCount(1_234)).toBe("1.2k");
    expect(formatTokenCount(9_450)).toBe("9.5k");
  });

  it("drops a trailing zero decimal", () => {
    expect(formatTokenCount(1_000)).toBe("1k");
    expect(formatTokenCount(2_000)).toBe("2k");
  });

  it("switches to whole thousands at ten thousand", () => {
    expect(formatTokenCount(10_400)).toBe("10k");
    expect(formatTokenCount(123_456)).toBe("123k");
  });

  it("applies the same shape to millions", () => {
    expect(formatTokenCount(1_200_000)).toBe("1.2m");
    expect(formatTokenCount(12_000_000)).toBe("12m");
  });
});
