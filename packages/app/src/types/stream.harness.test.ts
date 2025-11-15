import { describe, expect, it } from "vitest";

import { hydrateStreamState, type StreamItem, type ToolCallItem } from "./stream";
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
      rawContent: [
        {
          type: "input_json",
          json: {
            changes: [
              {
                file_path: "README.md",
                previous_content: "Old line\n",
                content: "New line\n",
              },
            ],
          },
        },
      ],
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
      rawContent: [
        {
          type: "input_text",
          text: "# README\nNew line\n",
        },
      ],
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
      rawContent: [
        {
          type: "input_json",
          json: {
            result: {
              command: "ls",
              output: "README.md\npackages\n",
            },
            metadata: { exit_code: 0, cwd: "/tmp/harness" },
          },
        },
      ],
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

  it("should hydrate tool payloads after a refresh", () => {
    const hydratedState = hydrateStreamState(STREAM_HARNESS_HYDRATED);
    const snapshots = extractHarnessSnapshots(hydratedState);

    expect(snapshots.edit?.payload.data.parsedEdits?.[0]?.diffLines.length).toBeGreaterThan(0);
    expect(snapshots.read?.payload.data.parsedReads?.[0]?.content).toContain("New line");
    expect(snapshots.command?.payload.data.parsedCommand?.output).toContain("README.md");
  });
});

function buildToolStartEvent({
  callId,
  server,
  tool,
  input,
  kind,
  status = "pending",
}: {
  callId: string;
  server: string;
  tool: string;
  input?: Record<string, unknown>;
  kind?: string;
  status?: string;
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
      raw: input ? { type: "mcp_tool_use", id: callId, server, name: tool, input } : undefined,
      input,
    },
  };
}

function buildToolResultEvent({
  callId,
  server,
  tool,
  rawContent,
  output,
}: {
  callId: string;
  server: string;
  tool: string;
  rawContent: Array<Record<string, unknown>>;
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
      raw: {
        type: "mcp_tool_result",
        tool_use_id: callId,
        server,
        tool_name: tool,
        content: rawContent,
      },
      output,
    },
  };
}

function extractHarnessSnapshots(state: StreamItem[]): Record<keyof typeof HARNESS_CALL_IDS, ToolCallItem | undefined> {
  const lookup = Object.values(HARNESS_CALL_IDS).reduce<Record<string, ToolCallItem | undefined>>(
    (acc, id) => {
      acc[id] = findToolByCallId(state, id);
      return acc;
    },
    {}
  );

  return {
    command: lookup[HARNESS_CALL_IDS.command],
    edit: lookup[HARNESS_CALL_IDS.edit],
    read: lookup[HARNESS_CALL_IDS.read],
  };
}

function findToolByCallId(state: StreamItem[], callId: string): ToolCallItem | undefined {
  return state.find(
    (item): item is ToolCallItem =>
      item.kind === "tool_call" &&
      item.payload.source === "agent" &&
      item.payload.data.callId === callId
  );
}
