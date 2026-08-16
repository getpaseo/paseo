import { describe, expect, it } from "vitest";
import type { PaseoSubagentRow, ProviderSubagentRow, SubagentRow } from "./select";
import {
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
    subtitle: null,
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
  it("counts eligible managed and terminal provider-owned children", () => {
    const providerRows: SubagentRow[] = [
      {
        kind: "provider",
        id: "native-running",
        parentAgentId: "parent",
        provider: "claude",
        title: "running",
        description: null,
        subtitle: null,
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
        subtitle: null,
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
    ).toBe(2);
  });

  it("excludes running and initializing managed children", () => {
    expect(
      countFinishedSubagents([
        row({ id: "running", status: "running" }),
        row({ id: "initializing", status: "initializing" }),
        row({ id: "finished", status: "idle" }),
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
      subtitle: overrides.subtitle ?? null,
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

describe("provider-owned row subtitles", () => {
  function providerRow(overrides: Partial<ProviderSubagentRow> = {}): ProviderSubagentRow {
    return {
      kind: "provider",
      id: "toolu_1",
      parentAgentId: "parent",
      provider: "claude",
      title: "general-purpose",
      description: "Reply with banana",
      subtitle: null,
      status: "running",
      requiresAttention: false,
      createdAt: new Date("2026-07-26T00:00:00.000Z"),
      ...overrides,
    };
  }

  it("displays provider context without interpreting it", () => {
    expect(
      buildSubagentRowPresentationData(
        providerRow({ subtitle: "general-purpose · Opus 5 · High · 16.5k tokens" }),
      ).subtitle,
    ).toBe("general-purpose · Opus 5 · High · 16.5k tokens");
  });

  it("falls back to the type when an older provider sends no subtitle", () => {
    expect(buildSubagentRowPresentationData(providerRow()).subtitle).toBe("general-purpose");
  });

  it("does not duplicate the type when it is already the primary label", () => {
    expect(
      buildSubagentRowPresentationData(
        providerRow({ description: null, subtitle: null, title: "general-purpose" }),
      ).subtitle,
    ).toBe("");
  });
});
