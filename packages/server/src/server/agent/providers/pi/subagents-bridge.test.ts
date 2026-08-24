import { describe, expect, test } from "vitest";

import { PiSubagentsBridge } from "./subagents-bridge.js";

function widget(payload: unknown) {
  return {
    type: "extension_ui_request" as const,
    id: "widget-1",
    method: "setWidget",
    widgetKey: "subagent-async",
    widgetLines: [`PI_SUBAGENT_ASYNC_JSON:${JSON.stringify(payload)}`],
  };
}

function makeSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    kind: "pi-subagents.async-status-snapshot",
    version: 1,
    generatedAt: 70_000,
    caps: {},
    omitted: { runs: 0, children: 0, byteLimitExceeded: false },
    runs: [
      {
        id: "async-1",
        kind: "workflow",
        label: "Implementation workflow",
        state: "running",
        startedAt: 10_000,
        activity: { currentTool: "read", turnCount: 2, toolCount: 3 },
        children: [
          {
            id: "child-1",
            kind: "step",
            label: "worker",
            state: "running",
            startedAt: 20_000,
            activity: { currentTool: "edit", toolCount: 1 },
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe("PiSubagentsBridge", () => {
  test("projects a live run and child into provider-subagent events", () => {
    const bridge = new PiSubagentsBridge();

    const result = bridge.handleExtensionUiRequest(widget(makeSnapshot()));

    expect(result.handled).toBe(true);
    expect(result.events).toHaveLength(2);
    expect(result.events[0]).toMatchObject({
      type: "provider_subagent",
      provider: "pi",
      event: {
        type: "upsert",
        title: "Implementation workflow",
        description: "Implementation workflow",
        status: "running",
        subtitle: "running · read · 2 turns · 3 tools · 1m",
        timestamp: new Date(10_000).toISOString(),
      },
    });
    expect(result.events[1]).toMatchObject({
      type: "provider_subagent",
      provider: "pi",
      event: {
        type: "upsert",
        title: "worker",
        description: "Implementation workflow / worker",
        status: "running",
        subtitle: "running · edit · 1 tools · 50s",
      },
    });

    const childEvent = result.events[1];
    if (childEvent?.type !== "provider_subagent" || childEvent.event.type !== "upsert") {
      throw new Error("Expected child provider-subagent upsert");
    }
    expect(bridge.resolveTarget(childEvent.event.id)).toEqual({
      asyncId: "async-1",
      childId: "child-1",
    });
  });

  test.each([
    ["complete", "completed"],
    ["failed", "failed"],
    ["paused", "failed"],
    ["rejected", "failed"],
    ["stopped", "canceled"],
    ["queued", "running"],
  ] as const)("maps %s to %s", (source, expected) => {
    const bridge = new PiSubagentsBridge();
    const result = bridge.handleExtensionUiRequest(
      widget(
        makeSnapshot({ runs: [{ id: "run", kind: "subagent", label: "worker", state: source }] }),
      ),
    );

    expect(result.events[0]).toMatchObject({
      type: "provider_subagent",
      event: { type: "upsert", status: expected },
    });
  });

  test("keeps parallel and nested children distinct and reconciles absent nodes", () => {
    const bridge = new PiSubagentsBridge();
    const first = bridge.handleExtensionUiRequest(
      widget(
        makeSnapshot({
          runs: [
            {
              id: "workflow-1",
              kind: "workflow",
              label: "parallel review",
              state: "running",
              children: [
                { id: "step:0", kind: "step", label: "worker", state: "running" },
                {
                  id: "step:1",
                  kind: "step",
                  label: "reviewer",
                  state: "running",
                  children: [
                    {
                      id: "nested-1",
                      kind: "subagent",
                      label: "nested tester",
                      state: "running",
                    },
                  ],
                },
              ],
            },
          ],
        }),
      ),
    );
    const upserts = first.events.filter(
      (event) => event.type === "provider_subagent" && event.event.type === "upsert",
    );
    expect(upserts).toHaveLength(4);
    expect(new Set(upserts.map((event) => event.event.id)).size).toBe(4);

    const second = bridge.handleExtensionUiRequest(
      widget(
        makeSnapshot({
          runs: [
            {
              id: "workflow-1",
              kind: "workflow",
              label: "parallel review",
              state: "running",
              children: [{ id: "step:0", kind: "step", label: "worker", state: "complete" }],
            },
          ],
        }),
      ),
    );
    expect(
      second.events.filter(
        (event) => event.type === "provider_subagent" && event.event.type === "remove",
      ),
    ).toHaveLength(2);
  });

  test("does not duplicate timeline rows across live and terminal inspections", () => {
    const bridge = new PiSubagentsBridge();
    const status = bridge.handleExtensionUiRequest(
      widget(
        makeSnapshot({
          runs: [{ id: "run", kind: "subagent", label: "worker", state: "running" }],
        }),
      ),
    );
    const target = status.inspectionTargets[0];
    if (!target) throw new Error("Expected inspection target");
    const reply = {
      kind: "pi-subagents.inspect-reply",
      version: 1,
      asyncId: "run",
      status: "running",
      messages: [{ role: "assistant", kind: "text", text: "same output" }],
    };

    bridge.beginInspection("live", target.descriptorId);
    const live = bridge.handleExtensionUiRequest({
      type: "extension_ui_request",
      id: "live",
      method: "setWidget",
      widgetKey: "subagent-inspect",
      widgetLines: [`PI_SUBAGENT_INSPECT_JSON:${JSON.stringify({ ...reply, requestId: "live" })}`],
    });
    bridge.beginInspection("terminal", target.descriptorId);
    const terminal = bridge.handleExtensionUiRequest({
      type: "extension_ui_request",
      id: "terminal",
      method: "setWidget",
      widgetKey: "subagent-inspect",
      widgetLines: [
        `PI_SUBAGENT_INSPECT_JSON:${JSON.stringify({ ...reply, requestId: "terminal", status: "complete", finalOutput: "same output" })}`,
      ],
    });

    expect(
      live.events.filter(
        (event) => event.type === "provider_subagent" && event.event.type === "timeline",
      ),
    ).toHaveLength(1);
    expect(
      terminal.events.filter(
        (event) => event.type === "provider_subagent" && event.event.type === "timeline",
      ),
    ).toHaveLength(0);
  });

  test("ignores unrelated extension widgets", () => {
    const bridge = new PiSubagentsBridge();
    expect(
      bridge.handleExtensionUiRequest({
        type: "extension_ui_request",
        id: "other",
        method: "setWidget",
        widgetKey: "other",
        widgetLines: ["text"],
      }),
    ).toEqual({ handled: false, events: [], inspectionTargets: [] });
  });

  test("maps a correlated inspection reply into descriptor and timeline events", () => {
    const bridge = new PiSubagentsBridge();
    const status = bridge.handleExtensionUiRequest(widget(makeSnapshot()));
    const child = status.inspectionTargets[1];
    if (!child) throw new Error("Expected child inspection target");
    expect(bridge.beginInspection("inspect-1", child.descriptorId)).toEqual({
      asyncId: "async-1",
      childId: "child-1",
    });

    const result = bridge.handleExtensionUiRequest({
      type: "extension_ui_request",
      id: "inspect-widget",
      method: "setWidget",
      widgetKey: "subagent-inspect",
      widgetLines: [
        `PI_SUBAGENT_INSPECT_JSON:${JSON.stringify({
          kind: "pi-subagents.inspect-reply",
          version: 1,
          requestId: "inspect-1",
          asyncId: "async-1",
          childId: "child-1",
          status: "complete",
          label: "worker",
          task: "Review the diff",
          messages: [
            { role: "user", kind: "text", text: "Review the diff" },
            { role: "assistant", kind: "text", text: "Done" },
            { role: "assistant", kind: "toolCall", name: "read", text: "src/a.ts" },
          ],
          finalOutput: "No issues",
          truncated: { task: false, messages: 2, finalOutput: false },
        })}`,
      ],
    });

    expect(result.events).toEqual([
      expect.objectContaining({
        type: "provider_subagent",
        event: expect.objectContaining({
          type: "upsert",
          id: child.descriptorId,
          title: "worker",
          description: "Review the diff",
        }),
      }),
      expect.objectContaining({
        type: "provider_subagent",
        event: expect.objectContaining({
          type: "timeline",
          id: child.descriptorId,
          item: { type: "user_message", text: "Review the diff" },
        }),
      }),
      expect.objectContaining({
        type: "provider_subagent",
        event: expect.objectContaining({
          type: "timeline",
          id: child.descriptorId,
          item: { type: "assistant_message", text: "Done" },
        }),
      }),
      expect.objectContaining({
        type: "provider_subagent",
        event: expect.objectContaining({
          type: "timeline",
          id: child.descriptorId,
          item: expect.objectContaining({ type: "tool_call", name: "read" }),
        }),
      }),
      expect.objectContaining({
        type: "provider_subagent",
        event: expect.objectContaining({
          type: "timeline",
          id: child.descriptorId,
          item: { type: "assistant_message", text: "No issues" },
        }),
      }),
      expect.objectContaining({
        type: "provider_subagent",
        event: expect.objectContaining({
          type: "timeline",
          id: child.descriptorId,
          item: expect.objectContaining({
            type: "assistant_message",
            text: expect.stringContaining("2 messages omitted"),
          }),
        }),
      }),
    ]);
  });

  test("reports an unsupported protocol version once", () => {
    const bridge = new PiSubagentsBridge();
    const unsupported = widget(makeSnapshot({ version: 2 }));

    expect(bridge.handleExtensionUiRequest(unsupported).events).toEqual([
      expect.objectContaining({
        type: "timeline",
        item: expect.objectContaining({
          type: "error",
          message: expect.stringContaining("version 2"),
        }),
      }),
    ]);
    expect(bridge.handleExtensionUiRequest(unsupported).events).toEqual([]);
  });

  test("reports malformed payloads without throwing", () => {
    const bridge = new PiSubagentsBridge();
    const result = bridge.handleExtensionUiRequest({
      type: "extension_ui_request",
      id: "bad",
      method: "setWidget",
      widgetKey: "subagent-async",
      widgetLines: ["PI_SUBAGENT_ASYNC_JSON:{bad"],
    });

    expect(result.events).toEqual([
      expect.objectContaining({
        type: "timeline",
        item: expect.objectContaining({ type: "error" }),
      }),
    ]);
  });
});
