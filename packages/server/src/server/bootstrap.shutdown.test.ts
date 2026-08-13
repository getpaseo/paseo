import { describe, expect, test } from "vitest";

import { runShutdownSequence } from "./bootstrap.js";

describe("runShutdownSequence", () => {
  test("runs every step before rethrowing the first failure", async () => {
    const firstFailure = new Error("first failure");
    const secondFailure = new Error("second failure");
    const completed: string[] = [];
    const reported: Array<{ name: string; error: unknown }> = [];

    const shutdown = runShutdownSequence(
      [
        ["first", () => completed.push("first")],
        [
          "second",
          () => {
            completed.push("second");
            throw firstFailure;
          },
        ],
        [
          "third",
          async () => {
            completed.push("third");
            throw secondFailure;
          },
        ],
        ["fourth", () => completed.push("fourth")],
      ],
      (name, error) => reported.push({ name, error }),
    );

    await expect(shutdown).rejects.toBe(firstFailure);
    expect(completed).toEqual(["first", "second", "third", "fourth"]);
    expect(reported).toEqual([
      { name: "second", error: firstFailure },
      { name: "third", error: secondFailure },
    ]);
  });
});
