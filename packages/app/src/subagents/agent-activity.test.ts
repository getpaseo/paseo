import { describe, expect, it } from "vitest";
import type { ProviderSubagentDescriptorPayload } from "@getpaseo/protocol/messages";
import {
  deriveAgentBucketWithSubagentActivity,
  hasRunningProviderSubagent,
} from "./agent-activity";
import { providerSubagentKey } from "./provider-store";

const SERVER = "server-1";

function descriptor(
  overrides: Partial<ProviderSubagentDescriptorPayload> &
    Pick<ProviderSubagentDescriptorPayload, "id">,
): ProviderSubagentDescriptorPayload {
  return {
    id: overrides.id,
    parentAgentId: overrides.parentAgentId ?? "agent-1",
    provider: overrides.provider ?? "pi",
    title: overrides.title ?? "worker",
    description: overrides.description ?? null,
    subtitle: overrides.subtitle ?? null,
    status: overrides.status ?? "running",
    createdAt: overrides.createdAt ?? "2026-04-20T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-04-20T00:00:00.000Z",
    toolCallId: overrides.toolCallId ?? null,
  };
}

function descriptors(
  entries: readonly ProviderSubagentDescriptorPayload[],
): Map<string, ProviderSubagentDescriptorPayload> {
  return new Map(
    entries.map((entry) => [providerSubagentKey(SERVER, entry.parentAgentId, entry.id), entry]),
  );
}

describe("hasRunningProviderSubagent", () => {
  it("reports a running child of the named parent", () => {
    const store = descriptors([descriptor({ id: "sub-a" })]);
    expect(hasRunningProviderSubagent(store, { serverId: SERVER, parentAgentId: "agent-1" })).toBe(
      true,
    );
  });

  it("ignores settled children", () => {
    for (const status of ["completed", "failed", "canceled"] as const) {
      const store = descriptors([descriptor({ id: "sub-a", status })]);
      expect(
        hasRunningProviderSubagent(store, { serverId: SERVER, parentAgentId: "agent-1" }),
      ).toBe(false);
    }
  });

  it("scopes children to their own parent and server", () => {
    const store = descriptors([descriptor({ id: "sub-a", parentAgentId: "agent-1" })]);
    expect(hasRunningProviderSubagent(store, { serverId: SERVER, parentAgentId: "agent-2" })).toBe(
      false,
    );
    expect(
      hasRunningProviderSubagent(store, { serverId: "server-2", parentAgentId: "agent-1" }),
    ).toBe(false);
  });

  it("does not read a longer parent id as a prefix match", () => {
    const store = descriptors([descriptor({ id: "sub-a", parentAgentId: "agent-10" })]);
    expect(hasRunningProviderSubagent(store, { serverId: SERVER, parentAgentId: "agent-1" })).toBe(
      false,
    );
    expect(hasRunningProviderSubagent(store, { serverId: SERVER, parentAgentId: "agent-10" })).toBe(
      true,
    );
  });

  it("is false without children", () => {
    expect(
      hasRunningProviderSubagent(new Map(), { serverId: SERVER, parentAgentId: "agent-1" }),
    ).toBe(false);
  });
});

describe("deriveAgentBucketWithSubagentActivity", () => {
  const finished = { status: "idle", requiresAttention: true } as const;

  it("keeps a parent with running children out of review", () => {
    expect(
      deriveAgentBucketWithSubagentActivity({ agent: finished, hasRunningProviderSubagent: true }),
    ).toBe("running");
  });

  it("leaves a finished parent alone once its children settle", () => {
    expect(
      deriveAgentBucketWithSubagentActivity({ agent: finished, hasRunningProviderSubagent: false }),
    ).toBe("attention");
  });

  it("turns a done parent running while children work", () => {
    expect(
      deriveAgentBucketWithSubagentActivity({
        agent: { status: "closed", requiresAttention: false },
        hasRunningProviderSubagent: true,
      }),
    ).toBe("running");
    expect(
      deriveAgentBucketWithSubagentActivity({
        agent: { status: "closed", requiresAttention: false },
        hasRunningProviderSubagent: false,
      }),
    ).toBe("done");
  });

  it("keeps a failure louder than a busy child", () => {
    expect(
      deriveAgentBucketWithSubagentActivity({
        agent: { status: "error", requiresAttention: true, attentionReason: "error" },
        hasRunningProviderSubagent: true,
      }),
    ).toBe("failed");
  });

  it("keeps an error status louder than a busy child when no attention reason is set", () => {
    expect(
      deriveAgentBucketWithSubagentActivity({
        agent: { status: "error", requiresAttention: false },
        hasRunningProviderSubagent: true,
      }),
    ).toBe("failed");
  });

  it("keeps a pending permission louder than a busy child", () => {
    expect(
      deriveAgentBucketWithSubagentActivity({
        agent: { status: "running", requiresAttention: false, pendingPermissionCount: 1 },
        hasRunningProviderSubagent: true,
      }),
    ).toBe("needs_input");
  });

  it("reports an active turn with no children as running", () => {
    expect(
      deriveAgentBucketWithSubagentActivity({
        agent: { status: "running", requiresAttention: false },
        hasRunningProviderSubagent: false,
      }),
    ).toBe("running");
  });
});
