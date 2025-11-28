import { describe, expect, it } from "vitest";

import {
  hydrateStreamState,
  type StreamItem,
  type AgentToolCallItem,
  type ToolCallStatus,
  isAgentToolCallItem,
} from "./stream";
import type { AgentStreamEventPayload } from "@server/server/messages";

type HarnessUpdate = { event: AgentStreamEventPayload; timestamp: Date };

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
    event: buildToolStartEvent({
      callId: HARNESS_CALL_IDS.edit,
      server: "editor",
      tool: "apply_patch",
      input: {
        file_path: "README.md",
        patch: "*** Begin Patch\n*** Update File: README.md\n@@\n-Old line\n+New line\n*** End Patch",
      },
    }),
    timestamp: new Date("2025-02-01T10:00:01Z"),
  },
  {
    event: buildToolResultEvent({
      callId: HARNESS_CALL_IDS.edit,
      server: "editor",
      tool: "apply_patch",
      output: {
        changes: [
          {
            file_path: "README.md",
            previous_content: "Old line\n",
            content: "New line\n",
          },
        ],
      },
    }),
    timestamp: new Date("2025-02-01T10:00:02Z"),
  },
  {
    event: buildToolStartEvent({
      callId: HARNESS_CALL_IDS.read,
      server: "editor",
      tool: "read_file",
      input: { file_path: "README.md" },
    }),
    timestamp: new Date("2025-02-01T10:00:03Z"),
  },
  {
    event: buildToolResultEvent({
      callId: HARNESS_CALL_IDS.read,
      server: "editor",
      tool: "read_file",
      output: { content: "# README\nNew line\n" },
    }),
    timestamp: new Date("2025-02-01T10:00:04Z"),
  },
  {
    event: buildToolStartEvent({
      callId: HARNESS_CALL_IDS.command,
      server: "command",
      tool: "shell",
      kind: "execute",
      input: { command: "ls" },
    }),
    timestamp: new Date("2025-02-01T10:00:05Z"),
  },
  {
    event: buildToolResultEvent({
      callId: HARNESS_CALL_IDS.command,
      server: "command",
      tool: "shell",
      output: {
        result: {
          command: "ls",
          output: "README.md\npackages\n",
        },
        metadata: { exit_code: 0, cwd: "/tmp/harness" },
      },
    }),
    timestamp: new Date("2025-02-01T10:00:06Z"),
  },
];

// Hydration snapshot recorded after refreshing the chat – this is the broken state we need to codify.
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
    event: buildToolStartEvent({
      callId: HARNESS_CALL_IDS.edit,
      server: "editor",
      tool: "apply_patch",
      status: "completed",
    }),
    timestamp: new Date("2025-02-01T10:05:01Z"),
  },
  {
    event: buildToolStartEvent({
      callId: HARNESS_CALL_IDS.read,
      server: "editor",
      tool: "read_file",
      status: "completed",
    }),
    timestamp: new Date("2025-02-01T10:05:02Z"),
  },
  {
    event: buildToolStartEvent({
      callId: HARNESS_CALL_IDS.command,
      server: "command",
      tool: "shell",
      kind: "execute",
      status: "completed",
    }),
    timestamp: new Date("2025-02-01T10:05:03Z"),
  },
];

describe("stream harness captures hydrated regression", () => {
  it("records tool payloads during the live run", () => {
    const liveState = hydrateStreamState(STREAM_HARNESS_LIVE);
    const snapshots = extractHarnessSnapshots(liveState);

    expect(snapshots.edit?.payload.data.parsedEdits?.[0]?.diffLines.length).toBeGreaterThan(0);
    expect(snapshots.read?.payload.data.parsedReads?.[0]?.content).toContain("New line");
    expect(snapshots.command?.payload.data.parsedCommand?.output).toContain("README.md");
  });

  it("documents that hydrated events without output lose parsed payloads", () => {
    // After a refresh, hydrated events only contain status but no input/output data.
    // Without full data, parsed payloads cannot be reconstructed.
    const hydratedState = hydrateStreamState(STREAM_HARNESS_HYDRATED);
    const snapshots = extractHarnessSnapshots(hydratedState);

    // Hydrated events exist but lack parsed content since input/output were not provided
    expect(snapshots.edit?.payload.data.parsedEdits).toBeUndefined();
    expect(snapshots.read?.payload.data.parsedReads).toBeUndefined();
    expect(snapshots.command?.payload.data.parsedCommand).toBeUndefined();
  });
});

function buildToolStartEvent({
  callId,
  server,
  tool,
  input,
  kind,
  status = "executing",
}: {
  callId: string;
  server: string;
  tool: string;
  input?: Record<string, unknown>;
  kind?: string;
  status?: ToolCallStatus;
}): AgentStreamEventPayload {
  return {
    type: "timeline",
    provider: "claude",
    item: {
      type: "tool_call",
      server,
      tool,
      status,
      callId,
      displayName: tool,
      kind,
      input,
    },
  };
}

function buildToolResultEvent({
  callId,
  server,
  tool,
  output,
}: {
  callId: string;
  server: string;
  tool: string;
  output?: Record<string, unknown>;
}): AgentStreamEventPayload {
  return {
    type: "timeline",
    provider: "claude",
    item: {
      type: "tool_call",
      server,
      tool,
      callId,
      displayName: tool,
      output,
    },
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
