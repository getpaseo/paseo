import { describe, expect, it } from "vitest";
import { parseCronExpression, validateCronExpression } from "./cron-expression.js";

describe("cron expression parser", () => {
  it("matches structurally valid expressions", () => {
    const cron = parseCronExpression("*/5 9-17 * 1,6 1-5");

    expect(cron.minute.matches(10)).toBe(true);
    expect(cron.minute.matches(11)).toBe(false);
    expect(cron.hour.matches(12)).toBe(true);
    expect(cron.hour.matches(18)).toBe(false);
    expect(cron.month.matches(6)).toBe(true);
    expect(cron.dayOfWeek.matches(0)).toBe(false);
  });

  it("rejects a step after a standalone number", () => {
    expect(validateCronExpression("0/15 * * * *")).toBe(
      "Invalid cron minute step: use * or a range before /",
    );
  });

  it.each([
    ["5/1 * * * *", "minute"],
    ["0,5/15 * * * *", "minute"],
    ["* 1/2 * * *", "hour"],
    ["* * 1/2 * *", "day-of-month"],
    ["* * * 1/2 *", "month"],
    ["* * * * 1/2", "day-of-week"],
  ])("rejects ignored numeric steps in %s", (expression, field) => {
    expect(validateCronExpression(expression)).toBe(
      `Invalid cron ${field} step: use * or a range before /`,
    );
  });

  it.each([
    { expression: "*/15 * * * *", expected: [0, 15, 30, 45] },
    { expression: "0-59/15 * * * *", expected: [0, 15, 30, 45] },
    { expression: "5-59/15 * * * *", expected: [5, 20, 35, 50] },
  ])("preserves supported steps in $expression", ({ expression, expected }) => {
    const cron = parseCronExpression(expression);
    const minutes = Array.from({ length: 60 }, (_, minute) => minute);
    const matches = minutes.filter((minute) => cron.minute.matches(minute));

    expect(matches).toEqual(expected);
  });

  it("reports invalid expressions with server-facing copy", () => {
    expect(validateCronExpression("* * *")).toBe("Cron expressions must have 5 fields");
    expect(validateCronExpression("*/5/2 * * * *")).toBe("Invalid cron minute step");
    expect(validateCronExpression("60 * * * *")).toBe("Invalid cron minute value");
    expect(validateCronExpression("* 24 * * *")).toBe("Invalid cron hour value");
    expect(validateCronExpression("* * 31-1 * *")).toBe("Invalid cron day-of-month range");
    expect(validateCronExpression("* * * */0 *")).toBe("Invalid cron month step");
    expect(validateCronExpression("* * * * mon")).toBe("Invalid cron day-of-week value");
  });
});
