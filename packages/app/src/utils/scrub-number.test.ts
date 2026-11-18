import { describe, expect, it } from "vitest";
import {
  clampScrubValue,
  compactCountFormat,
  createScrubSession,
  durationFormat,
  plainNumberFormat,
  scrubNotches,
  scrubValueFromDelta,
  stepScrubValue,
  usdFormat,
  type ScrubScale,
} from "./scrub-number";

const COUNT: ScrubScale = { min: 1, max: 100, step: 5, fineStep: 1 };
const LADDER: ScrubScale = { min: 1, max: 120, step: 1, fineStep: 1, ladder: [1, 5, 15, 60, 120] };
const CAP: ScrubScale = { ...LADDER, min: 0.01, nullable: true, ladder: [1, 5, 10] };

describe("scrubNotches", () => {
  it("counts whole notches toward zero", () => {
    expect(scrubNotches(0)).toBe(0);
    expect(scrubNotches(9)).toBe(0);
    expect(scrubNotches(10)).toBe(1);
    expect(scrubNotches(29)).toBe(2);
    expect(scrubNotches(-9)).toBe(0);
    expect(Object.is(scrubNotches(-9), 0)).toBe(true);
    expect(scrubNotches(-21)).toBe(-2);
    expect(scrubNotches(12, 4)).toBe(3);
  });
});

describe("clampScrubValue", () => {
  it("holds values inside the range", () => {
    expect(clampScrubValue(COUNT, 0)).toBe(1);
    expect(clampScrubValue(COUNT, 500)).toBe(100);
    expect(clampScrubValue(COUNT, 42)).toBe(42);
  });
});

describe("stepScrubValue on a grid", () => {
  it("moves by the coarse step and snaps an off-grid value first", () => {
    expect(stepScrubValue(COUNT, 25, 1)).toBe(30);
    expect(stepScrubValue(COUNT, 27, 1)).toBe(30);
    expect(stepScrubValue(COUNT, 27, -1)).toBe(25);
    expect(stepScrubValue(COUNT, 25, -2)).toBe(15);
  });

  it("moves by the fine step", () => {
    expect(stepScrubValue(COUNT, 25, 1, true)).toBe(26);
    expect(stepScrubValue(COUNT, 25, -3, true)).toBe(22);
  });

  it("clamps at both ends", () => {
    expect(stepScrubValue(COUNT, 5, -1)).toBe(1);
    expect(stepScrubValue(COUNT, 1, -4)).toBe(1);
    expect(stepScrubValue(COUNT, 98, 1)).toBe(100);
    expect(stepScrubValue(COUNT, 100, 9)).toBe(100);
  });

  it("does not drift on decimal steps", () => {
    const cents: ScrubScale = { min: 0, max: 10, step: 0.01 };
    expect(stepScrubValue(cents, 0.3, 1)).toBe(0.31);
    expect(stepScrubValue(cents, 0.3, -1)).toBe(0.29);
    expect(stepScrubValue(cents, 0.1, 2)).toBe(0.12);
  });

  it("leaves the value when there is no travel", () => {
    expect(stepScrubValue(COUNT, 27, 0)).toBe(27);
    expect(stepScrubValue(CAP, null, 0)).toBeNull();
  });
});

describe("stepScrubValue on a ladder", () => {
  it("walks the ladder on coarse moves", () => {
    expect(stepScrubValue(LADDER, 5, 1)).toBe(15);
    expect(stepScrubValue(LADDER, 5, 2)).toBe(60);
    expect(stepScrubValue(LADDER, 60, -2)).toBe(5);
  });

  it("goes to the next rung from an off-ladder value", () => {
    expect(stepScrubValue(LADDER, 20, 1)).toBe(60);
    expect(stepScrubValue(LADDER, 20, -1)).toBe(15);
  });

  it("stops at the ends of a non-nullable ladder", () => {
    expect(stepScrubValue(LADDER, 120, 3)).toBe(120);
    expect(stepScrubValue(LADDER, 1, -3)).toBe(1);
  });

  it("walks the fine grid instead of the ladder on fine moves", () => {
    expect(stepScrubValue(LADDER, 5, 1, true)).toBe(6);
    expect(stepScrubValue(LADDER, 5, -2, true)).toBe(3);
  });
});

describe("stepScrubValue on a nullable scale", () => {
  it("goes below the lowest value to null", () => {
    expect(stepScrubValue(CAP, 1, -1)).toBeNull();
    expect(stepScrubValue(CAP, 5, -5)).toBeNull();
    expect(stepScrubValue(CAP, 0.5, -1)).toBeNull();
  });

  it("comes up from null to the lowest rung", () => {
    expect(stepScrubValue(CAP, null, 1)).toBe(1);
    expect(stepScrubValue(CAP, null, 2)).toBe(5);
    expect(stepScrubValue(CAP, null, 99)).toBe(10);
    expect(stepScrubValue(CAP, null, -1)).toBeNull();
  });

  it("comes up from null to the minimum on fine moves", () => {
    expect(stepScrubValue(CAP, null, 1, true)).toBe(0.01);
    expect(stepScrubValue(CAP, null, 2, true)).toBe(1);
  });

  it("reaches the minimum before null on fine moves", () => {
    expect(stepScrubValue(CAP, 0.5, -1, true)).toBe(0.01);
    expect(stepScrubValue(CAP, 0.01, -1, true)).toBeNull();
  });
});

describe("scrubValueFromDelta", () => {
  it("turns pointer travel into notches from the start value", () => {
    expect(scrubValueFromDelta(COUNT, 25, 0)).toBe(25);
    expect(scrubValueFromDelta(COUNT, 25, 25)).toBe(35);
    expect(scrubValueFromDelta(COUNT, 25, -10)).toBe(20);
    expect(scrubValueFromDelta(COUNT, 25, 25, true)).toBe(27);
    expect(scrubValueFromDelta({ ...COUNT, pxPerNotch: 5 }, 25, 25)).toBe(50);
  });
});

describe("createScrubSession", () => {
  it("previews each move from where the drag began", () => {
    const session = createScrubSession(COUNT, 25);
    expect(session.move(10, false)).toBe(30);
    expect(session.move(30, false)).toBe(40);
    expect(session.move(-10, false)).toBe(20);
  });

  it("continues from the current value when the step size changes", () => {
    const session = createScrubSession(COUNT, 25);
    expect(session.move(20, false)).toBe(35);
    expect(session.move(20, true)).toBe(35);
    expect(session.move(40, true)).toBe(37);
    expect(session.move(40, false)).toBe(37);
    expect(session.move(50, false)).toBe(40);
  });
});

describe("plainNumberFormat", () => {
  const integer = plainNumberFormat({ integer: true });

  it("round-trips", () => {
    for (const value of [0, 1, 25, 500]) {
      expect(integer.parse(integer.format(value))).toBe(value);
    }
  });

  it("reads empty as null and junk as undefined", () => {
    expect(integer.parse("")).toBeNull();
    expect(integer.parse("  ")).toBeNull();
    expect(integer.parse("abc")).toBeUndefined();
    expect(integer.parse("-3")).toBeUndefined();
    expect(integer.parse("2.5")).toBeUndefined();
  });

  it("ignores separators and accepts fractions when allowed", () => {
    expect(integer.parse("1,000")).toBe(1000);
    expect(plainNumberFormat().parse("2.5")).toBe(2.5);
    expect(plainNumberFormat().parse(".5")).toBe(0.5);
  });

  it("reads a lone comma that is not a thousands group as the decimal point", () => {
    expect(plainNumberFormat().parse("2,5")).toBe(2.5);
    expect(plainNumberFormat().parse("2,50")).toBe(2.5);
    expect(integer.parse("2,5")).toBeUndefined();
    expect(integer.parse("1,000,000")).toBe(1_000_000);
  });
});

describe("durationFormat", () => {
  const minutes = durationFormat("minutes");
  const seconds = durationFormat("seconds");

  it("shows the largest whole unit", () => {
    expect(minutes.format(90)).toBe("90m");
    expect(minutes.format(120)).toBe("2h");
    expect(minutes.format(1440)).toBe("1d");
    expect(minutes.format(2160)).toBe("36h");
    expect(seconds.format(0)).toBe("0s");
    expect(seconds.format(45)).toBe("45s");
    expect(seconds.format(300)).toBe("5m");
    expect(seconds.format(3600)).toBe("1h");
  });

  it("round-trips", () => {
    for (const value of [1, 45, 60, 90, 1440, 10080]) {
      expect(minutes.parse(minutes.format(value))).toBe(value);
    }
    for (const value of [0, 5, 59, 60, 90, 3600]) {
      expect(seconds.parse(seconds.format(value))).toBe(value);
    }
  });

  it("reads units and bare numbers in the base unit", () => {
    expect(minutes.parse("90")).toBe(90);
    expect(minutes.parse("1.5h")).toBe(90);
    expect(minutes.parse("2 hours")).toBe(120);
    expect(minutes.parse("1D")).toBe(1440);
    expect(minutes.parse("90s")).toBe(2);
    expect(minutes.parse("1,5h")).toBe(90);
    expect(seconds.parse("30")).toBe(30);
    expect(seconds.parse("2m")).toBe(120);
  });

  it("refuses unknown units", () => {
    expect(minutes.parse("5x")).toBeUndefined();
    expect(minutes.parse("h")).toBeUndefined();
    expect(minutes.parse("")).toBeNull();
  });
});

describe("compactCountFormat", () => {
  const count = compactCountFormat();

  it("uses a suffix only when it is exact", () => {
    expect(count.format(500)).toBe("500");
    expect(count.format(250_000)).toBe("250k");
    expect(count.format(1_500_000)).toBe("1.5M");
    expect(count.format(10_000_000_000)).toBe("10B");
    expect(count.format(1_234_567)).toBe("1234567");
  });

  it("round-trips", () => {
    for (const value of [1000, 250_000, 1_500_000, 1_234_567, 10_000_000_000]) {
      expect(count.parse(count.format(value))).toBe(value);
    }
  });

  it("reads suffixes and separators", () => {
    expect(count.parse("250K")).toBe(250_000);
    expect(count.parse("2.5m")).toBe(2_500_000);
    expect(count.parse("1,000,000")).toBe(1_000_000);
    expect(count.parse("5x")).toBeUndefined();
    expect(count.parse("")).toBeNull();
  });
});

describe("usdFormat", () => {
  const usd = usdFormat();

  it("shows whole dollars and cents", () => {
    expect(usd.format(5)).toBe("$5");
    expect(usd.format(2.5)).toBe("$2.50");
    expect(usd.format(0.01)).toBe("$0.01");
  });

  it("round-trips", () => {
    for (const value of [0.01, 2.5, 5, 1000]) {
      expect(usd.parse(usd.format(value))).toBe(value);
    }
  });

  it("reads with or without the sign and rounds to the cent", () => {
    expect(usd.parse("12")).toBe(12);
    expect(usd.parse("$12.345")).toBe(12.35);
    expect(usd.parse("$")).toBeNull();
    expect(usd.parse("ten")).toBeUndefined();
  });

  it("reads a comma decimal from a comma-locale decimal pad", () => {
    expect(usd.parse("2,5")).toBe(2.5);
    expect(usd.parse("$0,75")).toBe(0.75);
    expect(usd.parse("1,000")).toBe(1000);
  });
});
