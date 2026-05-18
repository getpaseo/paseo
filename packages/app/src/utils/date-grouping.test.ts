import { describe, expect, it } from "vitest";
import { getDateBucket, groupByDate, getDateBucketLabel } from "./date-grouping";

describe("getDateBucket", () => {
  it("returns 'today' for a timestamp from today", () => {
    const now = new Date();
    expect(getDateBucket(now.toISOString())).toBe("today");
  });

  it("returns 'yesterday' for a timestamp from yesterday", () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(12, 0, 0, 0);
    expect(getDateBucket(yesterday.toISOString())).toBe("yesterday");
  });

  it("returns 'this-week' for 3 days ago", () => {
    const d = new Date();
    d.setDate(d.getDate() - 3);
    d.setHours(12, 0, 0, 0);
    expect(getDateBucket(d.toISOString())).toBe("this-week");
  });

  it("returns 'this-month' for 14 days ago", () => {
    const d = new Date();
    d.setDate(d.getDate() - 14);
    expect(getDateBucket(d.toISOString())).toBe("this-month");
  });

  it("returns 'older' for 60 days ago", () => {
    const d = new Date();
    d.setDate(d.getDate() - 60);
    expect(getDateBucket(d.toISOString())).toBe("older");
  });

  it("returns 'older' for null", () => {
    expect(getDateBucket(null)).toBe("older");
  });

  it("returns 'older' for invalid date string", () => {
    expect(getDateBucket("not-a-date")).toBe("older");
  });

  it("returns 'older' for empty string", () => {
    expect(getDateBucket("")).toBe("older");
  });
});

describe("groupByDate", () => {
  it("groups items by date bucket in chronological order", () => {
    const now = new Date();
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(12, 0, 0, 0);

    const items = [
      { id: "a", date: now.toISOString() },
      { id: "b", date: yesterday.toISOString() },
      { id: "c", date: now.toISOString() },
    ];

    const result = groupByDate(items, (item) => item.date);
    expect(result).toHaveLength(2);
    expect(result[0].bucket).toBe("today");
    expect(result[0].items).toHaveLength(2);
    expect(result[1].bucket).toBe("yesterday");
    expect(result[1].items).toHaveLength(1);
  });

  it("returns empty array for empty input", () => {
    const result = groupByDate([], () => null);
    expect(result).toHaveLength(0);
  });
});

describe("getDateBucketLabel", () => {
  it("returns human-readable labels", () => {
    expect(getDateBucketLabel("today")).toBe("Today");
    expect(getDateBucketLabel("yesterday")).toBe("Yesterday");
    expect(getDateBucketLabel("this-week")).toBe("Previous 7 Days");
    expect(getDateBucketLabel("this-month")).toBe("Previous 30 Days");
    expect(getDateBucketLabel("older")).toBe("Older");
  });
});
