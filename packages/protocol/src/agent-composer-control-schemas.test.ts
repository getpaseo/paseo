import { describe, expect, it } from "vitest";

import { AgentProfileSchema } from "./agent-profile.js";
import {
  AgentComposerControlInvokeRequestMessageSchema,
  AgentComposerControlInvokeResponseMessageSchema,
  AgentComposerControlSchema,
  AgentSnapshotPayloadSchema,
  ListProviderFeaturesResponseMessageSchema,
  SetAgentFeatureRequestMessageSchema,
} from "./messages.js";

const snapshotBase = {
  id: "agent-123",
  provider: "codex",
  cwd: "/tmp/project",
  model: "gpt-5",
  thinkingOptionId: null,
  effectiveThinkingOptionId: null,
  createdAt: "2026-04-03T12:00:00.000Z",
  updatedAt: "2026-04-03T12:00:00.000Z",
  lastUserMessageAt: null,
  status: "idle",
  capabilities: {
    supportsStreaming: true,
    supportsSessionPersistence: true,
    supportsDynamicModes: true,
    supportsMcpServers: true,
    supportsReasoningStream: true,
    supportsToolInvocations: true,
  },
  currentModeId: null,
  availableModes: [],
  pendingPermissions: [],
  persistence: null,
  title: null,
  labels: {},
} as const;

describe("agent composer control schemas", () => {
  it("parses action, toggle, and select controls", () => {
    expect(
      AgentComposerControlSchema.parse({
        kind: "action",
        id: "send-pony",
        label: "Send pony",
        icon: "sparkles",
      }),
    ).toMatchObject({ kind: "action", id: "send-pony" });

    expect(
      AgentComposerControlSchema.parse({
        kind: "toggle",
        id: "verbose",
        label: "Verbose",
        value: true,
      }),
    ).toMatchObject({ kind: "toggle", value: true });

    expect(
      AgentComposerControlSchema.parse({
        kind: "select",
        id: "tier",
        label: "Tier",
        value: "flex",
        options: [{ id: "flex", label: "Flex" }],
      }),
    ).toMatchObject({ kind: "select", value: "flex" });

    expect(
      AgentComposerControlSchema.parse({
        kind: "select",
        id: "tier",
        label: "Tier",
        value: "priority",
        options: [{ id: "priority", label: "Priority", icon: "zap" }],
      }),
    ).toMatchObject({
      kind: "select",
      options: [{ id: "priority", label: "Priority", icon: "zap" }],
    });
  });

  it("rejects unknown kinds and valueless toggles", () => {
    expect(
      AgentComposerControlSchema.safeParse({ kind: "slider", id: "x", label: "X" }).success,
    ).toBe(false);
    expect(
      AgentComposerControlSchema.safeParse({ kind: "toggle", id: "x", label: "X" }).success,
    ).toBe(false);
    expect(
      AgentComposerControlSchema.safeParse({
        kind: "select",
        id: "x",
        label: "X",
        value: null,
        options: [],
      }).success,
    ).toBe(false);
  });

  it("accepts controls on agent snapshots and the features response", () => {
    const snapshot = AgentSnapshotPayloadSchema.parse({
      ...snapshotBase,
      composerControls: [{ kind: "action", id: "send-pony", label: "Send pony" }],
    });
    expect(snapshot.composerControls).toHaveLength(1);

    // Old daemons omit the field entirely.
    expect(AgentSnapshotPayloadSchema.parse(snapshotBase).composerControls).toBeUndefined();

    const response = ListProviderFeaturesResponseMessageSchema.parse({
      type: "list_provider_features_response",
      payload: {
        provider: "codex",
        composerControls: [{ kind: "toggle", id: "verbose", label: "Verbose", value: false }],
        error: null,
        fetchedAt: "2026-04-03T12:00:00.000Z",
        requestId: "req-1",
      },
    });
    expect(response.payload.composerControls).toHaveLength(1);
  });

  it("parses the single live invoke request and response pair", () => {
    expect(
      AgentComposerControlInvokeRequestMessageSchema.parse({
        type: "agent.composer_control.invoke.request",
        agentId: "agent-123",
        controlId: "send-pony",
        requestId: "req-1",
      }).controlId,
    ).toBe("send-pony");

    expect(
      AgentComposerControlInvokeResponseMessageSchema.parse({
        type: "agent.composer_control.invoke.response",
        payload: {
          requestId: "req-1",
          agentId: "agent-123",
          accepted: true,
          error: null,
          controls: [{ kind: "toggle", id: "verbose", label: "Verbose", value: true }],
        },
      }).payload.controls,
    ).toHaveLength(1);
  });

  it("keeps the feature request usable without controls", () => {
    // The new RPC names must not collide with the existing feature RPC.
    expect(
      SetAgentFeatureRequestMessageSchema.parse({
        type: "set_agent_feature_request",
        agentId: "agent-123",
        featureId: "fast_mode",
        value: true,
        requestId: "req-1",
      }).featureId,
    ).toBe("fast_mode");
  });

  it("accepts control values on agent profiles", () => {
    const profile = AgentProfileSchema.parse({
      id: "profile-1",
      name: "Work",
      provider: "codex",
      featureValues: { fast_mode: true },
      controlValues: { verbose: true, tier: "flex" },
    });
    expect(profile.controlValues).toEqual({ verbose: true, tier: "flex" });
    expect(
      AgentProfileSchema.parse({ id: "p", name: "N", provider: "c" }).controlValues,
    ).toBeUndefined();
  });
});
