import { z } from "zod";

export const PRODUCTION_CATEGORIES = [
  "code",
  "components",
  "styles",
  "ci",
  "config",
  "tooling",
  "otherCode",
] as const;
export const CHANGE_CATEGORIES = [
  ...PRODUCTION_CATEGORIES,
  "comments",
  "docs",
  "tests",
  "generated",
  "formatting",
  "blank",
  "other",
] as const;
export type ChangeCategory = (typeof CHANGE_CATEGORIES)[number];
export const LineStatSchema = z.object({ additions: z.number(), deletions: z.number() });
export type LineStat = z.infer<typeof LineStatSchema>;
export const ChangeBreakdownSchema = z.object({
  code: LineStatSchema,
  components: LineStatSchema,
  styles: LineStatSchema,
  ci: LineStatSchema,
  config: LineStatSchema,
  tooling: LineStatSchema,
  otherCode: LineStatSchema,
  comments: LineStatSchema,
  docs: LineStatSchema,
  tests: LineStatSchema,
  generated: LineStatSchema,
  formatting: LineStatSchema,
  blank: LineStatSchema,
  other: LineStatSchema,
  commentsIncluded: LineStatSchema,
});
export type ChangeBreakdown = z.infer<typeof ChangeBreakdownSchema>;
export const DiffStatSchema = LineStatSchema.extend({
  // COMPAT(changeBreakdown): added in v0.8.0, remove optional after 2027-03-10.
  breakdown: ChangeBreakdownSchema.optional(),
});
export type DiffStat = z.infer<typeof DiffStatSchema>;

export function emptyChangeBreakdown(): ChangeBreakdown {
  const zero = () => ({ additions: 0, deletions: 0 });
  return {
    code: zero(),
    components: zero(),
    styles: zero(),
    ci: zero(),
    config: zero(),
    tooling: zero(),
    otherCode: zero(),
    comments: zero(),
    docs: zero(),
    tests: zero(),
    generated: zero(),
    formatting: zero(),
    blank: zero(),
    other: zero(),
    commentsIncluded: zero(),
  };
}

export function productionStat(breakdown: ChangeBreakdown): LineStat {
  return sumLineStats(PRODUCTION_CATEGORIES.map((category) => breakdown[category]));
}

export function sumLineStats(stats: readonly LineStat[]): LineStat {
  return stats.reduce(
    (sum, stat) => ({
      additions: sum.additions + stat.additions,
      deletions: sum.deletions + stat.deletions,
    }),
    { additions: 0, deletions: 0 },
  );
}

export function sumDiffStats(stats: readonly DiffStat[]): DiffStat {
  const total = sumLineStats(stats);
  if (stats.some((stat) => !stat.breakdown && stat.additions + stat.deletions > 0)) return total;
  const breakdown = emptyChangeBreakdown();
  for (const stat of stats) {
    if (!stat.breakdown) continue;
    for (const category of [...CHANGE_CATEGORIES, "commentsIncluded"] as const) {
      breakdown[category].additions += stat.breakdown[category].additions;
      breakdown[category].deletions += stat.breakdown[category].deletions;
    }
  }
  return { ...total, breakdown };
}
