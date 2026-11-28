import { describe, expect, it } from "vitest";
import { DAEMON_PERMISSIONS } from "@getpaseo/protocol/messages";
import { formatConnectedDuration, summarizePermissions } from "./scope-summary";

describe("summarizePermissions", () => {
  it("detects full access, read-only, and custom scope counts", () => {
    expect(summarizePermissions(DAEMON_PERMISSIONS)).toEqual({ kind: "full" });
    expect(summarizePermissions(["daemon.read", "workspace.read"])).toEqual({
      kind: "read_only",
    });
    expect(summarizePermissions(["workspace.read"])).toEqual({ kind: "read_only" });
    expect(summarizePermissions(["hub.execute", "workspace.read"])).toEqual({
      kind: "count",
      count: 2,
    });
    expect(summarizePermissions([])).toEqual({ kind: "count", count: 0 });
  });
});

describe("formatConnectedDuration", () => {
  const now = Date.parse("2026-11-28T15:00:00.000Z");

  it("formats relative durations cleanly", () => {
    expect(formatConnectedDuration("2026-11-28T14:59:30.000Z", now)).toEqual({
      kind: "just_now",
    });
    expect(formatConnectedDuration("2026-11-28T14:46:00.000Z", now)).toEqual({
      kind: "minutes",
      count: 14,
    });
    expect(formatConnectedDuration("2026-11-28T13:00:00.000Z", now)).toEqual({
      kind: "hours",
      count: 2,
    });
    expect(formatConnectedDuration("2026-11-25T15:00:00.000Z", now)).toEqual({
      kind: "days",
      count: 3,
    });
    expect(formatConnectedDuration("not-a-date", now)).toBeNull();
  });
});
