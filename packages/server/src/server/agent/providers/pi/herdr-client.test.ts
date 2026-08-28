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
});
