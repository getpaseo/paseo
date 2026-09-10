import { expect, it } from "vitest";
import { z } from "zod";
import { DiffStatSchema, emptyChangeBreakdown, productionStat, sumDiffStats } from "./diff-stat.js";

it("accepts old totals and permits old clients to read enriched totals", () => {
  const total = { additions: 3, deletions: 1 };
  expect(DiffStatSchema.parse(total)).toEqual(total);
  const oldSchema = z.object({ additions: z.number(), deletions: z.number() });
  const breakdown = emptyChangeBreakdown();
  breakdown.code = total;
  expect(oldSchema.parse({ ...total, breakdown })).toEqual(total);
  expect(DiffStatSchema.parse({ ...total, breakdown }).breakdown).toEqual(breakdown);
});

it("sums production categories without counting estimate annotations twice", () => {
  const first = emptyChangeBreakdown();
  first.code.additions = 2;
  first.comments.additions = 1;
  const second = emptyChangeBreakdown();
  second.ci.deletions = 3;
  second.tests.additions = 4;
  second.commentsIncluded.deletions = 3;
  const sum = sumDiffStats([
    { additions: 3, deletions: 0, breakdown: first },
    { additions: 4, deletions: 3, breakdown: second },
  ]);
  expect(sum).toMatchObject({ additions: 7, deletions: 3 });
  expect(productionStat(sum.breakdown!)).toEqual({ additions: 2, deletions: 3 });
  expect(sum.breakdown!.commentsIncluded.deletions).toBe(3);
});

it("does not present a partial folder breakdown as complete", () => {
  const sum = sumDiffStats([
    { additions: 1, deletions: 0 },
    { additions: 0, deletions: 0, breakdown: emptyChangeBreakdown() },
  ]);
  expect(sum).toEqual({ additions: 1, deletions: 0 });
});

it("retains the code breakdown when a binary file has no changed lines", () => {
  const breakdown = emptyChangeBreakdown();
  breakdown.code.additions = 1;
  const sum = sumDiffStats([
    { additions: 1, deletions: 0, breakdown },
    { additions: 0, deletions: 0 },
  ]);
  expect(sum.breakdown?.code.additions).toBe(1);
});
