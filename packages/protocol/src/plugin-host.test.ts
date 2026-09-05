import { describe, expect, test } from "vitest";
import {
  MAX_PLUGIN_AUTHORITY_LABELS,
  MAX_PLUGIN_AUTHORITY_STRING_BYTES,
  MAX_PLUGIN_HOST_WORKTREE_ID_BYTES,
  PluginCallerAuthoritySchema,
  PluginHostDeliverySendRequestSchema,
  PluginHostResponseSchema,
} from "./plugin-host.js";

const authority = {
  callerAgentId: "agent-one",
  agent: {
    id: "agent-one",
    workspaceId: "workspace-one",
    provider: "codex",
    status: "running",
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:00.000Z",
    lastActivityAt: "2026-09-04T00:00:00.000Z",
    title: null,
    cwd: "/tmp/workspace-one",
    model: "gpt-5",
    currentModeId: null,
    thinkingOptionId: null,
    requiresAttention: false,
    attentionReason: null,
    parentAgentId: null,
    labels: { role: "parent" },
  },
  workspace: null,
  effective: {
    provider: { known: true, value: "codex" },
    model: { known: true, value: "gpt-5" },
    thinking: { known: false },
    providerSessionId: { known: false },
  },
  securityCeiling: {
    filesystem: "unknown",
    network: "unknown",
    approvals: "unknown",
    unattended: "unknown",
  },
} as const;

describe("plugin caller host wire contract", () => {
  test("accepts immutable authority snapshots with explicit unknown values", () => {
    expect(PluginCallerAuthoritySchema.parse(authority)).toEqual(authority);
  });

  test("bounds strings, labels, and opaque worktree identifiers", () => {
    expect(
      PluginCallerAuthoritySchema.safeParse({
        ...authority,
        callerAgentId: "x".repeat(MAX_PLUGIN_AUTHORITY_STRING_BYTES + 1),
      }).success,
    ).toBe(false);
    expect(
      PluginCallerAuthoritySchema.safeParse({
        ...authority,
        agent: {
          ...authority.agent,
          labels: Object.fromEntries(
            Array.from({ length: MAX_PLUGIN_AUTHORITY_LABELS + 1 }, (_, index) => [
              `label-${index}`,
              "value",
            ]),
          ),
        },
      }).success,
    ).toBe(false);
    expect(
      PluginHostDeliverySendRequestSchema.safeParse({
        type: "plugin.host.delivery.send.request",
        requestId: "request-one",
        invocationId: "invocation-one",
        generation: 1,
        installationId: "installation-one",
        capabilityNonce: "nonce-one",
        payload: JSON.parse('{"__proto__":"unsafe"}'),
        options: { deliveryId: "delivery-one" },
      }).success,
    ).toBe(true);
    expect(
      PluginHostDeliverySendRequestSchema.safeParse({
        type: "plugin.host.delivery.send.request",
        requestId: "request-one",
        invocationId: "invocation-one",
        generation: 1,
        installationId: "installation-one",
        capabilityNonce: "nonce-one",
        payload: { event: "finished" },
      }).success,
    ).toBe(false);
    expect(
      PluginHostDeliverySendRequestSchema.safeParse({
        type: "plugin.host.worktree.remove.request",
        requestId: "request-one",
        invocationId: "invocation-one",
        generation: 1,
        installationId: "installation-one",
        id: "x".repeat(MAX_PLUGIN_HOST_WORKTREE_ID_BYTES + 1),
      }).success,
    ).toBe(false);
  });

  test("keeps host response envelopes strict and operation-shaped", () => {
    expect(
      PluginHostResponseSchema.safeParse({
        type: "plugin.host.worktree.remove.response",
        requestId: "request-one",
        invocationId: "invocation-one",
        generation: 1,
        installationId: "installation-one",
        ok: true,
        result: undefined,
      }).success,
    ).toBe(true);
    expect(
      PluginHostResponseSchema.safeParse({
        type: "plugin.host.delivery.send.response",
        requestId: "request-one",
        invocationId: "invocation-one",
        generation: 1,
        installationId: "installation-one",
        ok: true,
        result: { deliveryId: "not-a-record" },
      }).success,
    ).toBe(false);
  });
});
