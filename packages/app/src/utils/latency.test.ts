import { describe, expect, it } from "vitest";
import { formatLatency } from "./latency";

describe("formatLatency", () => {
  it("uses microseconds for sub-millisecond latency", () => {
    expect(formatLatency(0.4)).toBe("400\u00b5s");
  });

  it("uses integer milliseconds below one second", () => {
    expect(formatLatency(7.200000047683716)).toBe("7ms");
    expect(formatLatency(999.4)).toBe("999ms");
  });

  it("uses seconds at one second and above", () => {
    expect(formatLatency(1000)).toBe("1s");
    expect(formatLatency(1234)).toBe("1.2s");
    expect(formatLatency(10_040)).toBe("10s");
  });
});
