import { describe, expect, test } from "vitest";

import { parseHerdrAgentListPayload, parseHerdrAgentPayload } from "./herdr-client.js";

describe("Herdr client parsing", () => {
  test("parses wrapped Herdr agent list output", () => {
    expect(
      parseHerdrAgentListPayload({
        id: "cli:agent:list",
        result: {
          type: "agent_list",
          agents: [
            {
              id: "pane-1",
              name: "firstmate",
              kind: "pi",
              status: "idle",
              cwd: "/workspace/project",
              pane_id: "%7",
              agent_session: {
                id: "native-pi-session",
                file: "/tmp/pi/native.jsonl",
              },
            },
          ],
        },
      }),
    ).toEqual([
      {
        target: "firstmate",
        id: "pane-1",
        name: "firstmate",
        kind: "pi",
        status: "idle",
        cwd: "/workspace/project",
        paneId: "%7",
        nativeSessionId: "native-pi-session",
        nativeSessionFile: "/tmp/pi/native.jsonl",
        lastActivityAt: null,
      },
    ]);
  });

  test("parses wrapped Herdr agent get output", () => {
    expect(
      parseHerdrAgentPayload({
        id: "cli:agent:get",
        result: {
          type: "agent",
          agent: {
            target: "%9",
            agent_kind: "pi",
            lifecycle: "working",
            working_directory: "/workspace/project",
            session_file: "/tmp/pi/native.jsonl",
            session_id: "native-pi-session",
          },
        },
      }),
    ).toMatchObject({
      target: "%9",
      kind: "pi",
      status: "working",
      cwd: "/workspace/project",
      nativeSessionId: "native-pi-session",
      nativeSessionFile: "/tmp/pi/native.jsonl",
    });
  });

  test("parses real path-shaped Herdr Pi list records", () => {
    expect(
      parseHerdrAgentListPayload({
        id: "cli:agent:list",
        result: {
          agents: [
            {
              agent: "pi",
              agent_session: {
                agent: "pi",
                kind: "path",
                source: "herdr:pi",
                value:
                  "/home/example/.pi/agent/sessions/--workspace-project--/2026-08-28T17-39-22-374Z_01a04974-6e86-7db6-a718-ffd7c4f0af2d.jsonl",
              },
              agent_status: "working",
              cwd: "/workspace/registered-project",
              foreground_cwd: "/workspace/project",
              pane_id: "w1Q:p2",
            },
          ],
          type: "agent_list",
        },
      }),
    ).toEqual([
      {
        target: "w1Q:p2",
        kind: "pi",
        status: "working",
        cwd: "/workspace/project",
        paneId: "w1Q:p2",
        nativeSessionId: "01a04974-6e86-7db6-a718-ffd7c4f0af2d",
        nativeSessionFile:
          "/home/example/.pi/agent/sessions/--workspace-project--/2026-08-28T17-39-22-374Z_01a04974-6e86-7db6-a718-ffd7c4f0af2d.jsonl",
        lastActivityAt: null,
      },
    ]);
  });

  test("parses real path-shaped Herdr Pi get records", () => {
    expect(
      parseHerdrAgentPayload({
        id: "cli:agent:get",
        result: {
          agent: {
            agent: "pi",
            agent_session: {
              agent: "pi",
              kind: "path",
              source: "herdr:pi",
              value:
                "/home/example/.pi/agent/sessions/--workspace-project--/2026-08-28T17-39-22-374Z_01a04974-6e86-7db6-a718-ffd7c4f0af2d.jsonl",
            },
            agent_status: "idle",
            cwd: "/workspace/registered-project",
            foreground_cwd: "/workspace/project",
            pane_id: "w1Q:p2",
          },
          type: "agent_info",
        },
      }),
    ).toMatchObject({
      target: "w1Q:p2",
      kind: "pi",
      status: "idle",
      cwd: "/workspace/project",
      paneId: "w1Q:p2",
      nativeSessionId: "01a04974-6e86-7db6-a718-ffd7c4f0af2d",
      nativeSessionFile:
        "/home/example/.pi/agent/sessions/--workspace-project--/2026-08-28T17-39-22-374Z_01a04974-6e86-7db6-a718-ffd7c4f0af2d.jsonl",
    });
  });
});
