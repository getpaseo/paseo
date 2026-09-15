import { describe, expect, test } from "vitest";
import { parseExecutionDecision, routes } from "./execution-routing";

describe("execution routing policy", () => {
  test.each(routes)("accepts $category as $model/$effort", (route) => {
    expect(
      parseExecutionDecision(
        JSON.stringify({ ...route, provider: "codex", reason: `Matched ${route.category}` }),
      ),
    ).toEqual({ ...route, provider: "codex", reason: `Matched ${route.category}` });
  });

  test("rejects a combination outside its policy row", () => {
    expect(() =>
      parseExecutionDecision(
        JSON.stringify({
          category: "bounded",
          provider: "codex",
          model: "gpt-6-astra",
          effort: "xhigh",
          reason: "Invented combination",
        }),
      ),
    ).toThrow("routing policy");
  });
});
