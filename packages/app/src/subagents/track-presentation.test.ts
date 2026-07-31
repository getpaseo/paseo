import { describe, expect, it } from "vitest";
import type { PaseoSubagentRow, ProviderSubagentRow, SubagentRow } from "./select";
import {
  buildSubagentPaneDetails,
  buildSubagentRowPresentationData,
  countFinishedSubagents,
  formatHeaderLabel,
  resolveRowLabel,
} from "./track-presentation";

function row(
  overrides: Partial<PaseoSubagentRow> & Pick<PaseoSubagentRow, "id">,
): PaseoSubagentRow {
  return {
    kind: "paseo",
    id: overrides.id,
    provider: overrides.provider ?? "codex",
    title: overrides.title ?? `Agent ${overrides.id}`,
    description: null,
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

describe("countFinishedSubagents", () => {
  it("counts only terminal provider-owned children", () => {
    const providerRows: SubagentRow[] = [
      {
        kind: "provider",
        id: "native-running",
        parentAgentId: "parent",
        provider: "claude",
        title: "running",
        description: null,
        model: null,
        effort: null,
        status: "running",
        requiresAttention: false,
        createdAt: new Date("2026-04-20T00:00:00.000Z"),
      },
      {
        kind: "provider",
        id: "native-failed",
        parentAgentId: "parent",
        provider: "claude",
        title: "failed",
        description: null,
        model: null,
        effort: null,
        status: "failed",
        requiresAttention: true,
        createdAt: new Date("2026-04-20T00:00:01.000Z"),
      },
    ];

    expect(
      countFinishedSubagents([
        row({ id: "managed-running", status: "running" }),
        row({ id: "managed-idle", status: "idle" }),
        ...providerRows,
      ]),
    ).toBe(1);
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

describe("buildSubagentRowPresentationData", () => {
  it("namespaces the key with a subagent prefix", () => {
    expect(buildSubagentRowPresentationData(row({ id: "child-a" })).key).toBe(
      "paseo_subagent_child-a",
    );
  });

  it("marks the row ready when the title resolves to a real label", () => {
    const presentation = buildSubagentRowPresentationData(row({ id: "a", title: "Build it" }));
    expect(presentation.titleState).toBe("ready");
    expect(presentation.label).toBe("Build it");
  });

  it("marks the row loading and blanks the label for the placeholder title", () => {
    const presentation = buildSubagentRowPresentationData(row({ id: "a", title: "new agent" }));
    expect(presentation.titleState).toBe("loading");
    expect(presentation.label).toBe("");
  });

  it("maps a running row to the running status bucket so callers render the synced loader", () => {
    expect(buildSubagentRowPresentationData(row({ id: "a", status: "running" })).statusBucket).toBe(
      "running",
    );
  });

  it("maps an idle row to the done status bucket so callers render the static provider icon", () => {
    expect(buildSubagentRowPresentationData(row({ id: "a", status: "idle" })).statusBucket).toBe(
      "done",
    );
  });

  it("ignores requiresAttention on the source row when computing the bucket", () => {
    expect(
      buildSubagentRowPresentationData(row({ id: "a", status: "idle", requiresAttention: true }))
        .statusBucket,
    ).toBe("done");
  });
});

describe("buildSubagentRowPresentationData for provider rows", () => {
  function providerRow(overrides: Partial<ProviderSubagentRow> = {}): ProviderSubagentRow {
    return {
      kind: "provider",
      id: overrides.id ?? "toolu_1",
      parentAgentId: "parent",
      provider: "claude",
      title: "title" in overrides ? (overrides.title ?? null) : "general-purpose",
      description: overrides.description ?? null,
      model: overrides.model ?? null,
      effort: overrides.effort ?? null,
      status: overrides.status ?? "running",
      requiresAttention: false,
      createdAt: overrides.createdAt ?? new Date("2026-07-26T00:00:00.000Z"),
    };
  }

  it("names the row after the task and demotes the subagent type", () => {
    const presentation = buildSubagentRowPresentationData(
      providerRow({ title: "general-purpose", description: "Reply with banana" }),
    );
    expect(presentation.label).toBe("Reply with banana");
    expect(presentation.subtitle).toBe("general-purpose");
  });

  it("tells two siblings of the same type apart", () => {
    const left = buildSubagentRowPresentationData(
      providerRow({ id: "a", description: "Summarize the docs" }),
    );
    const right = buildSubagentRowPresentationData(
      providerRow({ id: "b", description: "Reply with banana" }),
    );
    expect(left.label).not.toBe(right.label);
  });

  it("keeps type-as-label and an empty subtitle when a provider reports no task", () => {
    const presentation = buildSubagentRowPresentationData(
      providerRow({ title: "Provider child", description: null }),
    );
    expect(presentation.label).toBe("Provider child");
    expect(presentation.subtitle).toBe("");
  });

  it("stays in the loading state when neither field is known", () => {
    const presentation = buildSubagentRowPresentationData(
      providerRow({ title: null, description: null }),
    );
    expect(presentation.titleState).toBe("loading");
  });

  it("leaves managed subagent rows with no subtitle", () => {
    expect(buildSubagentRowPresentationData(row({ id: "a", title: "Managed" })).subtitle).toBe("");
  });
});

describe("subagent runtime and usage in the row subtitle", () => {
  function providerRow(overrides: Partial<ProviderSubagentRow> = {}): ProviderSubagentRow {
    return {
      kind: "provider",
      id: "toolu_1",
      parentAgentId: "parent",
      provider: "claude",
      title: "general-purpose",
      description: "Reply with banana",
      model: null,
      effort: null,
      status: "running",
      requiresAttention: false,
      createdAt: new Date("2026-07-26T00:00:00.000Z"),
      ...overrides,
    };
  }

  it("appends the observed model and effort after the type", () => {
    expect(
      buildSubagentRowPresentationData(providerRow({ model: "claude-opus-5", effort: "high" }))
        .subtitle,
    ).toBe("general-purpose · claude-opus-5 · high");
  });

  it("keeps cost out of the row, which carries identity only", () => {
    // Tokens are a context-size reading dominated by the reused prompt cache, and a tool count
    // says little at a glance. Neither survives in a dense row; the pane shows both.
    expect(buildSubagentRowPresentationData(providerRow()).subtitle).toBe("general-purpose");
  });

  it("never invents a model, effort, or cost that was not observed", () => {
    expect(buildSubagentRowPresentationData(providerRow()).subtitle).toBe("general-purpose");
  });
});

describe("buildSubagentPaneDetails", () => {
  it("renders nothing before a descriptor arrives", () => {
    expect(buildSubagentPaneDetails(null)).toBe("");
  });

  it("renders nothing when the runtime was never observed", () => {
    expect(buildSubagentPaneDetails({ model: null, effort: null, usage: null })).toBe("");
  });

  it("lists the observed model and effort", () => {
    expect(buildSubagentPaneDetails({ model: "claude-opus-5", effort: "high", usage: null })).toBe(
      "claude-opus-5 · high",
    );
  });

  it("shows duration alongside cost, unlike the dense track row", () => {
    expect(
      buildSubagentPaneDetails({
        model: "claude-opus-5",
        effort: null,
        usage: { totalTokens: 16484, toolUses: 2, durationMs: 10934 },
      }),
    ).toBe("claude-opus-5 · 16.5k tokens, 2 tools, 10.9s");
  });

  it("shows duration on its own for a child that reported no token cost", () => {
    expect(
      buildSubagentPaneDetails({ model: null, effort: null, usage: { durationMs: 4100 } }),
    ).toBe("4.1s");
  });

  it("keeps sub-second and multi-minute durations terse", () => {
    expect(
      buildSubagentPaneDetails({ model: null, effort: null, usage: { durationMs: 412 } }),
    ).toBe("412ms");
    expect(
      buildSubagentPaneDetails({ model: null, effort: null, usage: { durationMs: 125_400 } }),
    ).toBe("2m 5s");
    expect(
      buildSubagentPaneDetails({ model: null, effort: null, usage: { durationMs: 119_600 } }),
    ).toBe("2m 0s");
  });

  it("omits a zeroed usage report rather than showing 0 tokens", () => {
    expect(
      buildSubagentPaneDetails({
        model: null,
        effort: null,
        usage: { totalTokens: 0, toolUses: 0, durationMs: 0 },
      }),
    ).toBe("");
  });
});
