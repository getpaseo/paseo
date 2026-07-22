import { describe, expect, test } from "vitest";

import type { ACPToolSnapshot } from "./acp-agent.js";
import { mapGrokAcpToolDetail, transformGrokAcpToolSnapshot } from "./grok-tool-mapper.js";

const unknownDetail = {
  type: "unknown" as const,
  input: null,
  output: null,
};

function snapshot(
  partial: Partial<ACPToolSnapshot> & Pick<ACPToolSnapshot, "toolCallId" | "title">,
): ACPToolSnapshot {
  return {
    kind: null,
    status: "completed",
    content: null,
    locations: null,
    ...partial,
  };
}

describe("mapGrokAcpToolDetail", () => {
  test("maps Task / spawn_subagent tools to sub_agent detail", () => {
    const detail = mapGrokAcpToolDetail(
      snapshot({
        toolCallId: "call-1",
        title: "Wait 10s random phrase",
        kind: "other",
        rawInput: {
          variant: "Task",
          description: "Wait 10s random phrase",
          subagent_type: "general-purpose",
          prompt: "Wait 10 seconds",
          run_in_background: true,
        },
        rawOutput: {
          type: "Text",
          text: [
            "Subagent started in background.",
            "subagent_id: 019f8338-b3dd-7812-9035-175ed021d531",
            "type: general-purpose",
            "description: Wait 10s random phrase",
            "",
            'Use get_command_or_subagent_output with task_ids=["019f8338-b3dd-7812-9035-175ed021d531"] and timeout_ms to wait for results.',
          ].join("\n"),
        },
      }),
      unknownDetail,
    );

    expect(detail).toEqual({
      type: "sub_agent",
      subAgentType: "general-purpose",
      description: "Wait 10s random phrase",
      childSessionId: "019f8338-b3dd-7812-9035-175ed021d531",
      // Identity lines already in the header are stripped from the log body.
      log: "Subagent started in background.",
    });
  });

  test("maps spawn_subagent title before kind update", () => {
    const detail = mapGrokAcpToolDetail(
      snapshot({
        toolCallId: "call-2",
        title: "spawn_subagent",
        rawInput: {
          description: "Explore registry",
          prompt: "Map the provider registry",
          subagent_type: "explore",
          background: true,
        },
      }),
      unknownDetail,
    );

    expect(detail).toMatchObject({
      type: "sub_agent",
      subAgentType: "explore",
      description: "Explore registry",
      log: "",
    });
  });

  test("maps TaskOutput wait tools to plain_text summary", () => {
    const detail = mapGrokAcpToolDetail(
      snapshot({
        toolCallId: "call-3",
        title: "Get task output: 2 tasks",
        kind: "other",
        rawInput: {
          variant: "TaskOutput",
          task_ids: ["id-a", "id-b"],
          timeout_ms: 60_000,
        },
        rawOutput: {
          type: "TaskOutput",
          MultiResult: {
            mode: "wait_all",
            results: [
              {
                task_id: "id-a",
                command: "[subagent:general-purpose] Wait 10s random phrase",
                status: "completed",
                output: "Quiet rain on empty streets.\n\n<subagent_meta>id=id-a",
              },
              {
                task_id: "id-b",
                command: "[subagent:general-purpose] Wait 20s random phrase",
                status: "completed",
                output: "Velvet moons juggle quietly.",
              },
            ],
          },
        },
      }),
      unknownDetail,
    );

    expect(detail.type).toBe("plain_text");
    if (detail.type !== "plain_text") return;
    // Summary line is the row label; per-result lines are body only (no double header).
    expect(detail.label).toBe("2/2 completed (wait_all)");
    expect(detail.icon).toBe("bot");
    expect(detail.text).not.toContain("2/2 completed (wait_all)");
    expect(detail.text).toContain("Quiet rain on empty streets.");
    expect(detail.text).toContain("Velvet moons juggle quietly.");
    expect(detail.text).not.toContain("<subagent_meta");
  });

  test("normalizes TaskOutput tool title so the row is not double-labeled", () => {
    const transformed = transformGrokAcpToolSnapshot(
      snapshot({
        toolCallId: "call-wait",
        title: "multi-wait (wait_all)",
        kind: "other",
        rawInput: { variant: "TaskOutput", task_ids: ["a", "b"] },
      }),
    );
    expect(transformed.title).toBe("Wait");
  });

  test("leaves unrelated tools unchanged", () => {
    const detail = mapGrokAcpToolDetail(
      snapshot({
        toolCallId: "call-4",
        title: "grep",
        kind: "search",
        rawInput: { pattern: "foo" },
      }),
      {
        type: "search",
        query: "foo",
        toolName: "search",
      },
    );
    expect(detail).toEqual({
      type: "search",
      query: "foo",
      toolName: "search",
    });
  });

  test("maps nested action.query web_search off placeholder title", () => {
    const detail = mapGrokAcpToolDetail(
      snapshot({
        toolCallId: "call-ws",
        title: "Web search:",
        kind: "search",
        rawInput: {
          action: {
            type: "search",
            query: "Azure Container Apps serverless GPU pricing",
            sources: [
              {
                type: "url",
                url: "https://learn.microsoft.com/en-us/azure/container-apps/billing",
                title: "Billing in Azure Container Apps",
              },
              {
                type: "url",
                url: "https://azure.microsoft.com/en-us/pricing/details/container-apps/",
              },
            ],
          },
        },
      }),
      {
        // What the generic ACP mapper produces without action.query support.
        type: "search",
        query: "Web search:",
        toolName: "search",
      },
    );

    expect(detail).toEqual({
      type: "search",
      query: "Azure Container Apps serverless GPU pricing",
      toolName: "web_search",
      webResults: [
        {
          title: "Billing in Azure Container Apps",
          url: "https://learn.microsoft.com/en-us/azure/container-apps/billing",
        },
        {
          title: "https://azure.microsoft.com/en-us/pricing/details/container-apps/",
          url: "https://azure.microsoft.com/en-us/pricing/details/container-apps/",
        },
      ],
    });
  });

  test("maps Web search title with inline query when action is empty", () => {
    const detail = mapGrokAcpToolDetail(
      snapshot({
        toolCallId: "call-ws-title",
        title: "Web search: Gemma 4 pan-and-scan",
        kind: "search",
        rawInput: {},
      }),
      {
        type: "search",
        query: "Web search: Gemma 4 pan-and-scan",
        toolName: "search",
      },
    );

    expect(detail).toMatchObject({
      type: "search",
      query: "Gemma 4 pan-and-scan",
      toolName: "web_search",
    });
  });

  test("maps nested action.url open_page fetch", () => {
    const detail = mapGrokAcpToolDetail(
      snapshot({
        toolCallId: "call-fetch",
        title: "open_page",
        kind: "other",
        rawInput: {
          action: {
            type: "open_page",
            url: "https://example.com/docs",
            prompt: "summarize pricing",
          },
        },
      }),
      {
        // Generic ACP mapper without action.url support falls back to title.
        type: "other",
        content: null,
      } as never,
    );

    expect(detail).toMatchObject({
      type: "fetch",
      url: "https://example.com/docs",
      prompt: "summarize pricing",
    });
  });

  test("maps fetch with uri/href aliases under action", () => {
    const detail = mapGrokAcpToolDetail(
      snapshot({
        toolCallId: "call-fetch-uri",
        title: "Browse",
        kind: "fetch",
        rawInput: {
          action: {
            uri: "https://example.com/via-uri",
          },
        },
      }),
      {
        type: "fetch",
        url: "Browse",
      },
    );

    expect(detail).toMatchObject({
      type: "fetch",
      url: "https://example.com/via-uri",
    });
  });

  test("does not treat placeholder Web search title as the query when defaultDetail is placeholder", () => {
    const detail = mapGrokAcpToolDetail(
      snapshot({
        toolCallId: "call-ws-ph",
        title: "Web search:",
        kind: "search",
        rawInput: {
          action: {
            type: "search",
            query: "real query from action",
          },
        },
      }),
      {
        // After generic mapper reverts to main: query falls back to snapshot.title.
        type: "search",
        query: "Web search:",
        toolName: "search",
      },
    );

    expect(detail).toMatchObject({
      type: "search",
      query: "real query from action",
      toolName: "web_search",
    });
  });
});
