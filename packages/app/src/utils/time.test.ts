import { describe, expect, it } from "vitest";
import { formatTimeAgo } from "./time";

describe("formatTimeAgo", () => {
  it("returns 'just now' for very recent dates", () => {
    const result = formatTimeAgo(new Date());
    expect(result).toBe("just now");
  });

  it("returns seconds for dates less than a minute ago", () => {
    const date = new Date(Date.now() - 30_000); // 30 seconds ago
    const result = formatTimeAgo(date);
    expect(result).toBe("30s ago");
  });

  it("returns minutes for dates less than an hour ago", () => {
    const date = new Date(Date.now() - 5 * 60_000); // 5 minutes ago
    const result = formatTimeAgo(date);
    expect(result).toBe("5m ago");
  });

  it("returns hours for dates less than a day ago", () => {
    const date = new Date(Date.now() - 3 * 60 * 60_000); // 3 hours ago
    const result = formatTimeAgo(date);
    expect(result).toBe("3h ago");
  });

  it("returns days for dates less than a week ago", () => {
    const date = new Date(Date.now() - 3 * 24 * 60 * 60_000); // 3 days ago
    const result = formatTimeAgo(date);
    expect(result).toBe("3d ago");
  });

  it("returns month and day for dates older than a week", () => {
    const date = new Date(Date.now() - 30 * 24 * 60 * 60_000); // 30 days ago
    const result = formatTimeAgo(date);
    // Should be something like "Jan 15" depending on the date
    expect(result).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
  });

  it("handles future dates gracefully by showing 'just now'", () => {
    // Clock drift can cause future timestamps
    const futureDate = new Date(Date.now() + 5 * 60_000); // 5 minutes in future
    const result = formatTimeAgo(futureDate);
    expect(result).toBe("just now");
  });

  it("handles near-future dates (1 second ahead)", () => {
    const futureDate = new Date(Date.now() + 1_000);
    const result = formatTimeAgo(futureDate);
    expect(result).toBe("just now");
  });

  it("handles exactly 10 seconds ago (boundary)", () => {
    const date = new Date(Date.now() - 10_000); // exactly 10 seconds ago
    const result = formatTimeAgo(date);
    expect(result).toBe("10s ago");
  });

  it("handles exactly 1 minute ago (boundary)", () => {
    const date = new Date(Date.now() - 60_000); // exactly 1 minute ago
    const result = formatTimeAgo(date);
    expect(result).toBe("1m ago");
  });

  it("handles exactly 1 hour ago (boundary)", () => {
    const date = new Date(Date.now() - 60 * 60_000); // exactly 1 hour ago
    const result = formatTimeAgo(date);
    expect(result).toBe("1h ago");
  });

  it("handles exactly 1 day ago (boundary)", () => {
    const date = new Date(Date.now() - 24 * 60 * 60_000); // exactly 1 day ago
    const result = formatTimeAgo(date);
    expect(result).toBe("1d ago");
  });
});
