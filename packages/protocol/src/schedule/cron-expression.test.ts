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
