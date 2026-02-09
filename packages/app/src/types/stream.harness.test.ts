import { describe, expect, it } from "vitest";

import {
  hydrateStreamState,
  type StreamItem,
  type AgentToolCallItem,
  isAgentToolCallItem,
} from "./stream";
import type { AgentStreamEventPayload } from "@server/shared/messages";
import type { ToolCallDetail } from "@server/server/agent/agent-sdk-types";

type HarnessUpdate = { event: AgentStreamEventPayload; timestamp: Date };
type ToolStatus = "running" | "completed" | "failed" | "canceled";

const HARNESS_CALL_IDS = {
  command: "harness-command",
  edit: "harness-edit",
  read: "harness-read",
};

const STREAM_HARNESS_LIVE: HarnessUpdate[] = [
  {
    event: {
      type: "timeline",
      provider: "claude",
      item: {
        type: "user_message",
        text: "Create a README snippet, show me the diff, and run ls.",
        messageId: "msg-live-user",
      },
    },
    timestamp: new Date("2025-02-01T10:00:00Z"),
  },
  {
    event: buildToolEvent({
      callId: HARNESS_CALL_IDS.edit,
      name: "apply_patch",
      status: "running",
      input: {
        file_path: "README.md",
        patch: "*** Begin Patch\n*** Update File: README.md\n@@\n-Old line\n+New line\n*** End Patch",
      },
      detail: {
        type: "edit",
        filePath: "README.md",
        unifiedDiff: "@@\n-Old line\n+New line",
      },
    }),
    timestamp: new Date("2025-02-01T10:00:01Z"),
  },
  {
    event: buildToolEvent({
      callId: HARNESS_CALL_IDS.edit,
      name: "apply_patch",
      status: "completed",
      output: {
        files: [
          {
            path: "README.md",
            patch: "@@\n-Old line\n+New line",
          },
        ],
      },
      input: null,
    }),
    timestamp: new Date("2025-02-01T10:00:02Z"),
  },
  {
    event: buildToolEvent({
      callId: HARNESS_CALL_IDS.read,
      name: "read_file",
      status: "running",
      input: { file_path: "README.md" },
      detail: {
        type: "read",
        filePath: "README.md",
      },
    }),
    timestamp: new Date("2025-02-01T10:00:03Z"),
  },
  {
    event: buildToolEvent({
      callId: HARNESS_CALL_IDS.read,
      name: "read_file",
      status: "completed",
      output: { content: "# README\nNew line\n" },
      input: null,
    }),
    timestamp: new Date("2025-02-01T10:00:04Z"),
  },
  {
    event: buildToolEvent({
      callId: HARNESS_CALL_IDS.command,
      name: "shell",
      status: "running",
      input: { command: "ls" },
      detail: {
        type: "shell",
        command: "ls",
      },
    }),
    timestamp: new Date("2025-02-01T10:00:05Z"),
  },
  {
    event: buildToolEvent({
      callId: HARNESS_CALL_IDS.command,
      name: "shell",
      status: "completed",
      output: {
        result: {
          command: "ls",
          output: "README.md\npackages\n",
        },
        metadata: { exit_code: 0, cwd: "/tmp/harness" },
      },
      input: null,
    }),
    timestamp: new Date("2025-02-01T10:00:06Z"),
  },
];

const STREAM_HARNESS_HYDRATED: HarnessUpdate[] = [
  {
    event: {
      type: "timeline",
      provider: "claude",
      item: {
        type: "user_message",
        text: "Create a README snippet, show me the diff, and run ls.",
        messageId: "msg-live-user",
      },
    },
    timestamp: new Date("2025-02-01T10:05:00Z"),
  },
  {
    event: buildToolEvent({
      callId: HARNESS_CALL_IDS.edit,
      name: "apply_patch",
      status: "completed",
      input: {
        file_path: "README.md",
      },
      output: null,
    }),
    timestamp: new Date("2025-02-01T10:05:01Z"),
  },
  {
    event: buildToolEvent({
      callId: HARNESS_CALL_IDS.read,
      name: "read_file",
      status: "completed",
      input: { file_path: "README.md" },
      output: null,
    }),
    timestamp: new Date("2025-02-01T10:05:02Z"),
  },
  {
    event: buildToolEvent({
      callId: HARNESS_CALL_IDS.command,
      name: "shell",
      status: "completed",
      input: { command: "ls" },
      output: null,
    }),
    timestamp: new Date("2025-02-01T10:05:03Z"),
  },
];

describe("stream harness canonical payloads", () => {
  it("keeps provider detail payloads during live run", () => {
    const liveState = hydrateStreamState(STREAM_HARNESS_LIVE);
    const snapshots = extractHarnessSnapshots(liveState);

    expect(snapshots.edit?.payload.data.detail).toEqual({
      type: "edit",
      filePath: "README.md",
      unifiedDiff: "@@\n-Old line\n+New line",
    });
    expect(snapshots.read?.payload.data.detail).toEqual({
      type: "read",
      filePath: "README.md",
    });
    expect(snapshots.command?.payload.data.detail).toEqual({
      type: "shell",
      command: "ls",
    });
  });

  it("keeps tool records hydrated even when output is missing", () => {
    const hydratedState = hydrateStreamState(STREAM_HARNESS_HYDRATED);
    const snapshots = extractHarnessSnapshots(hydratedState);

    expect(snapshots.edit?.payload.data.status).toBe("completed");
    expect(snapshots.read?.payload.data.status).toBe("completed");
    expect(snapshots.command?.payload.data.status).toBe("completed");
  });
});

function buildToolEvent({
  callId,
  name,
  status,
  input = null,
  output = null,
  error,
  detail,
}: {
  callId: string;
  name: string;
  status: ToolStatus;
  input?: Record<string, unknown> | null;
  output?: Record<string, unknown> | null;
  error?: unknown;
  detail?: ToolCallDetail;
}): AgentStreamEventPayload {
  const canonicalDetail: ToolCallDetail = detail ?? {
    type: "unknown",
    rawInput: input,
    rawOutput: output,
  };

  const baseItem = {
    type: "tool_call" as const,
    name,
    status,
    callId,
    detail: canonicalDetail,
  };

  const item =
    status === "failed"
      ? {
          ...baseItem,
          status: "failed" as const,
          error: error ?? { message: "failed" },
        }
      : {
          ...baseItem,
          error: null,
        };

  return {
    type: "timeline",
    provider: "claude",
    item,
  };
}

function extractHarnessSnapshots(
  state: StreamItem[]
): Record<keyof typeof HARNESS_CALL_IDS, AgentToolCallItem | undefined> {
  const lookup = Object.values(HARNESS_CALL_IDS).reduce<
    Record<string, AgentToolCallItem | undefined>
  >((acc, id) => {
    acc[id] = findToolByCallId(state, id);
    return acc;
  }, {});

  return {
    command: lookup[HARNESS_CALL_IDS.command],
    edit: lookup[HARNESS_CALL_IDS.edit],
    read: lookup[HARNESS_CALL_IDS.read],
  };
}

function findToolByCallId(state: StreamItem[], callId: string): AgentToolCallItem | undefined {
  return state.find(
    (item): item is AgentToolCallItem =>
      isAgentToolCallItem(item) && item.payload.data.callId === callId
  );
}
