import { describe, expect, it } from "vitest";
import type { SubagentRow } from "./select";
import { formatHeaderLabel, resolveRowLabel } from "./track-presentation";

function row(overrides: Partial<SubagentRow> & Pick<SubagentRow, "id">): SubagentRow {
  return {
    id: overrides.id,
    provider: overrides.provider ?? "codex",
    title: overrides.title ?? `Agent ${overrides.id}`,
    status: overrides.status ?? "idle",
    requiresAttention: overrides.requiresAttention ?? false,
    createdAt: overrides.createdAt ?? new Date("2026-04-20T00:00:00.000Z"),
  };
}

describe("formatHeaderLabel", () => {
  it("uses singular 'subagent' for a single row", () => {
    expect(formatHeaderLabel([row({ id: "a" })])).toBe("1 subagent");
  });

  it("uses plural 'subagents' for two rows with no running rows", () => {
    expect(formatHeaderLabel([row({ id: "a" }), row({ id: "b" })])).toBe("2 subagents");
  });

  it("appends the running count when at least one row is running", () => {
    expect(
      formatHeaderLabel([row({ id: "a", status: "running" }), row({ id: "b" }), row({ id: "c" })]),
    ).toBe("3 subagents · 1 running");
  });

  it("counts every running row in the suffix", () => {
    expect(
      formatHeaderLabel([
        row({ id: "a", status: "running" }),
        row({ id: "b", status: "running" }),
        row({ id: "c", requiresAttention: true }),
        row({ id: "d" }),
        row({ id: "e" }),
      ]),
    ).toBe("5 subagents · 2 running");
  });

  it("ignores requiresAttention on non-running rows in the header copy", () => {
    expect(
      formatHeaderLabel([
        row({ id: "a", status: "error", requiresAttention: false }),
        row({ id: "b", status: "idle", requiresAttention: false }),
        row({ id: "c", status: "idle", requiresAttention: true }),
      ]),
    ).toBe("3 subagents");
  });

  it("still counts running rows even when they require attention", () => {
    expect(
      formatHeaderLabel([
        row({ id: "a", status: "error", requiresAttention: true }),
        row({ id: "b", status: "running", requiresAttention: true }),
        row({ id: "c", status: "idle", requiresAttention: true }),
      ]),
    ).toBe("3 subagents · 1 running");
  });

  it("uses singular 'subagent' for a single row that requires attention upstream", () => {
    expect(formatHeaderLabel([row({ id: "a", requiresAttention: true })])).toBe("1 subagent");
  });
});

describe("resolveRowLabel", () => {
  it("returns null when title is not a string", () => {
    expect(resolveRowLabel(null as unknown as SubagentRow["title"])).toBe(null);
  });

  it("returns null for whitespace-only titles", () => {
    expect(resolveRowLabel("   ")).toBe(null);
  });

  it("returns null for the placeholder 'new agent' regardless of case", () => {
    expect(resolveRowLabel("new agent")).toBe(null);
    expect(resolveRowLabel("New Agent")).toBe(null);
    expect(resolveRowLabel("  NEW AGENT  ")).toBe(null);
  });

  it("returns the trimmed title for real names", () => {
    expect(resolveRowLabel("  Build the thing  ")).toBe("Build the thing");
  });
});
