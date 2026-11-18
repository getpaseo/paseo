import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  AgentResourcePolicySchema,
  describeInvalidAgentResourcePolicy,
  isEmptyAgentResourcePolicy,
} from "./agent-resources.js";
import {
  AgentSnapshotPayloadSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "./messages.js";
import { ScheduleUpdateRequestSchema } from "./schedule/rpc-schemas.js";
import { StoredScheduleSchema } from "./schedule/types.js";
import { validateWSOutboundMessage } from "./validation/ws-outbound.js";

function rejection(input: unknown): string | null {
  const result = AgentResourcePolicySchema.safeParse(input);
  return result.success ? null : (result.error.issues[0]?.path.join(".") ?? "");
}

describe("agent resource policy", () => {
  test("accepts every control at the limits Linux and systemd accept", () => {
    const policy = {
      nice: -20,
      cpuWeight: 10000,
      cpuQuotaPercent: 1,
      memoryHighMb: 16,
      memoryMaxMb: 16777216,
      allowedCpus: [0, 1023],
    };

    expect(AgentResourcePolicySchema.parse(policy)).toEqual(policy);
    expect(AgentResourcePolicySchema.parse({ nice: 19, cpuWeight: 1 })).toEqual({
      nice: 19,
      cpuWeight: 1,
    });
  });

  test("rejects values outside those limits, naming the control", () => {
    expect(rejection({ nice: 20 })).toBe("nice");
    expect(rejection({ nice: -21 })).toBe("nice");
    expect(rejection({ nice: 1.5 })).toBe("nice");
    expect(rejection({ cpuWeight: 0 })).toBe("cpuWeight");
    expect(rejection({ cpuQuotaPercent: 0 })).toBe("cpuQuotaPercent");
    expect(rejection({ memoryMaxMb: 8 })).toBe("memoryMaxMb");
    expect(rejection({ allowedCpus: [] })).toBe("allowedCpus");
    expect(rejection({ allowedCpus: [-1] })).toBe("allowedCpus.0");
  });

  test("rejects contradictions the field ranges cannot express", () => {
    expect(describeInvalidAgentResourcePolicy({ memoryHighMb: 2048, memoryMaxMb: 1024 })).toBe(
      "memoryHighMb must not exceed memoryMaxMb",
    );
    expect(describeInvalidAgentResourcePolicy({ allowedCpus: [2, 2] })).toBe(
      "allowedCpus must not repeat a CPU",
    );
    expect(describeInvalidAgentResourcePolicy({ memoryHighMb: 1024, memoryMaxMb: 1024 })).toBe(
      null,
    );
  });

  test("treats a policy with no controls as no policy", () => {
    expect(isEmptyAgentResourcePolicy(undefined)).toBe(true);
    expect(isEmptyAgentResourcePolicy({})).toBe(true);
    expect(isEmptyAgentResourcePolicy({ nice: 0 })).toBe(false);
  });
});

describe("agent resource wire compatibility", () => {
  const snapshot = {
    id: "agent-1",
    provider: "codex",
    cwd: "/repo",
    model: null,
    createdAt: "2026-11-16T00:00:00.000Z",
    updatedAt: "2026-11-16T00:00:00.000Z",
    lastUserMessageAt: null,
    status: "idle",
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: false,
      supportsMcpServers: false,
      supportsReasoningStream: false,
      supportsToolInvocations: false,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title: null,
    labels: {},
  };

  test("an old client parses a snapshot that carries a policy, and a new one parses it without", () => {
    const oldClientSchema = AgentSnapshotPayloadSchema.omit({ resources: true });

    expect(oldClientSchema.parse({ ...snapshot, resources: { nice: 5 } })).not.toHaveProperty(
      "resources",
    );
    expect(AgentSnapshotPayloadSchema.parse(snapshot).resources).toBeUndefined();
  });

  test("a new daemon parses create and schedule requests from a client that knows no policies", () => {
    const create = SessionInboundMessageSchema.parse({
      type: "create_agent_request",
      config: { provider: "codex", cwd: "/repo" },
      labels: {},
      requestId: "req-1",
    });
    const update = ScheduleUpdateRequestSchema.parse({
      type: "schedule/update",
      requestId: "req-2",
      scheduleId: "sched-1",
      newAgentConfig: { model: "gpt-5" },
    });

    expect(create.type === "create_agent_request" && create.config.resources).toBeUndefined();
    expect(update.newAgentConfig).toEqual({ model: "gpt-5" });
  });

  test("schedules stored before policies existed still load", () => {
    const stored = StoredScheduleSchema.parse({
      id: "sched-1",
      name: null,
      prompt: "nightly",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "new-agent", config: { provider: "codex", cwd: "/repo" } },
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      nextRunAt: null,
      lastRunAt: null,
      pausedAt: null,
      expiresAt: null,
      maxRuns: null,
      runs: [],
    });

    expect(stored.target).toEqual({
      type: "new-agent",
      config: { provider: "codex", cwd: "/repo" },
    });
  });

  test("the generated client validator accepts both resource responses", () => {
    const status = {
      backend: "systemd",
      active: true,
      unit: "paseo_0123456789-agent_0123456789abcdef.slice",
      cgroup: "/sys/fs/cgroup/user.slice/paseo.slice",
      controls: {
        nice: { state: "applied", actual: 10 },
        memoryMaxMb: { state: "denied", actual: null, message: "Access denied" },
        allowedCpus: { state: "applied", actual: [0, 1] },
      },
    };
    const responses = [
      {
        type: "agent.resources.get.response",
        payload: {
          requestId: "req-1",
          agentId: "agent-1",
          capabilities: {
            backend: "nice",
            controls: Object.fromEntries(
              [
                "nice",
                "cpuWeight",
                "cpuQuotaPercent",
                "memoryHighMb",
                "memoryMaxMb",
                "allowedCpus",
              ].map((control) => [
                control,
                control === "nice"
                  ? { supported: true }
                  : { supported: false, reason: "Needs systemd" },
              ]),
            ),
          },
          resources: { nice: 10, memoryMaxMb: 1024, allowedCpus: [0, 1] },
          status,
          error: null,
        },
      },
      {
        type: "agent.resources.set.response",
        payload: {
          requestId: "req-2",
          agentId: "agent-1",
          accepted: true,
          error: null,
          resources: null,
          status: null,
        },
      },
    ];

    for (const message of responses) {
      expect(SessionOutboundMessageSchema.parse(message)).toEqual(message);
      expect(validateWSOutboundMessage({ type: "session", message }).success).toBe(true);
    }
    expect(
      validateWSOutboundMessage({
        type: "session",
        message: {
          ...responses[1],
          payload: { ...responses[1].payload, accepted: "yes" },
        },
      }).success,
    ).toBe(false);
  });

  test("wire schemas stay structural so the validator generator can compile them", () => {
    const shape = AgentResourcePolicySchema.shape;
    for (const field of Object.values(shape)) {
      expect(field).toBeInstanceOf(z.ZodOptional);
    }
  });
});
