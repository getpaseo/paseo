import { describe, expect, test, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiExtensionHost } from "../index.js";
import {
  parseToolArgs,
  parseToolResult,
  type PiToolResult,
  type PiTrackedToolCall,
} from "../../tool-call-mapper.js";
import { mapPiChildSession } from "../child-session.js";
import { readSubagentFixture, verifySubagentFixture } from "../subagent-fixture-test.js";
import pino from "pino";
import { PiRpcAgentClient } from "../../agent.js";
import { FakePi } from "../../test-utils/fake-pi.js";
import type { AgentStreamEvent } from "../../../../agent-sdk-types.js";

function mapping(toolCall: PiTrackedToolCall, result: PiToolResult) {
  return createPiExtensionHost().mapToolCall({
    callId: "test-call",
    toolName: toolCall.toolName,
    args: toolCall.args,
    status: result ? "completed" : "running",
    result,
  });
}
function mapToolDetail(toolCall: PiTrackedToolCall, result: PiToolResult) {
  return mapping(toolCall, result)?.detail;
}

function hasChildTimeline(events: AgentStreamEvent[]) {
  return events.some(
    (event) => event.type === "provider_subagent" && event.event.type === "timeline",
  );
}

function hasCompletedChild(events: AgentStreamEvent[]) {
  return events.some(
    (event) =>
      event.type === "provider_subagent" &&
      event.event.type === "upsert" &&
      event.event.status === "completed",
  );
}

function subagentUpserts(events: AgentStreamEvent[]) {
  return events.flatMap((event) =>
    event.type === "provider_subagent" && event.event.type === "upsert" ? [event.event] : [],
  );
}

function reportedUpsert(events: AgentStreamEvent[], id: string, status?: string) {
  return subagentUpserts(events).some(
    (event) => event.id === id && (status === undefined || event.status === status),
  );
}

describe("pi-subagents adapter", () => {
  test("follows async status and transcript without bg_wait", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paseo-pi-async-"));
    const file = join(dir, "child.jsonl");
    const received: AgentStreamEvent[] = [];
    const host = createPiExtensionHost();
    try {
      host.follow((event) => received.push(event));
      host.mapToolCall({
        callId: "call-1",
        toolName: "subagent",
        args: { agent: "scout", task: "Inspect", async: true },
        status: "completed",
        result: {
          details: { mode: "single", runId: "run-1", asyncId: "run-1", asyncDir: dir, results: [] },
        },
      });
      await writeFile(
        file,
        '{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"BEGIN"}]}}\n',
      );
      await writeFile(
        join(dir, "status.json"),
        JSON.stringify({
          state: "running",
          steps: [{ agent: "scout", status: "running", sessionFile: file }],
        }),
      );
      await expect.poll(() => hasChildTimeline(received)).toBe(true);
      await writeFile(
        join(dir, "status.json"),
        JSON.stringify({
          state: "complete",
          steps: [{ agent: "scout", status: "complete", sessionFile: file }],
        }),
      );
      await expect.poll(() => hasCompletedChild(received)).toBe(true);
    } finally {
      host.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("settles an async run and reads its transcript from the completion notice on replay", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paseo-pi-async-"));
    const file = join(dir, "child.jsonl");
    try {
      await writeFile(
        file,
        '{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"DONE"}]}}\n',
      );
      const host = createPiExtensionHost();
      host.mapToolCall({
        callId: "call-1",
        toolName: "subagent",
        args: { agent: "scout", task: "Inspect", async: true },
        status: "completed",
        result: {
          details: { mode: "single", runId: "run-1", asyncId: "run-1", asyncDir: dir, results: [] },
        },
      });
      const notice = host.mapCustomMessage({
        role: "custom",
        customType: "subagent-notify",
        content: [
          "Background task completed: **scout**",
          "",
          "Session file: /tmp/not-the-session-line.jsonl",
          "",
          `Retention-managed async directory: ${dir}`,
          "",
          `Session file: ${file}`,
        ].join("\n"),
      });
      expect(notice?.subagents).toEqual([{ type: "upsert", id: "call-1", status: "completed" }]);
      expect(hasChildTimeline(await notice!.hydration)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("maps completed subagent calls with task input to sub-agent detail", () => {
    const toolCall = parseToolArgs("subagent", {
      agent: "reviewer",
      task: "Review the Pi mapper change",
    });
    const result = parseToolResult({
      content: [{ type: "text", text: "The mapper change preserves provider status." }],
    });

    expect(mapToolDetail(toolCall, result)).toEqual({
      type: "sub_agent",
      subAgentType: "reviewer",
      description: "Review the Pi mapper change",
      log: "The mapper change preserves provider status.",
    });
  });

  test("maps the captured foreground run and child Pi timeline live and on replay", async () => {
    const raw = readSubagentFixture(new URL("./fixtures/foreground.json", import.meta.url));
    const result = raw.events.find(
      (event) =>
        event.type === "tool_execution_end" &&
        event.toolName === "subagent" &&
        event.result &&
        typeof event.result === "object" &&
        "details" in event.result &&
        Array.isArray(event.result.details?.results) &&
        event.result.details.results.length > 0,
    );
    if (!result || result.type !== "tool_execution_end")
      throw new Error("Missing captured child session");
    const original = (result.result as { details: { results: Array<{ sessionFile: string }> } })
      .details.results[0].sessionFile;
    const fixture = readSubagentFixture(new URL("./fixtures/foreground.json", import.meta.url), {
      from: original,
      to: fileURLToPath(new URL("./fixtures/child-session.jsonl", import.meta.url)),
    });
    const events = await verifySubagentFixture(fixture);
    expect(
      events
        .filter((event) => event.event.type === "upsert")
        .map((event) => (event.event.type === "upsert" ? event.event.status : null)),
    ).toContain("completed");
    expect(events.filter((event) => event.event.type === "timeline").length).toBeGreaterThan(0);
  });

  test("settles captured async runs from the completion notice live and on replay", async () => {
    const fixture = readSubagentFixture(new URL("./fixtures/background.json", import.meta.url));
    const events = await verifySubagentFixture(fixture);
    expect(events.findLast((event) => event.event.type === "upsert")?.event).toEqual(
      expect.objectContaining({ status: "completed" }),
    );
  });

  test("maps bg_wait completion to the original async child", async () => {
    const raw = readSubagentFixture(new URL("./fixtures/wait.json", import.meta.url));
    const wait = raw.events.find(
      (event) => event.type === "tool_execution_end" && event.toolName === "bg_wait",
    );
    if (!wait || wait.type !== "tool_execution_end")
      throw new Error("Missing captured bg_wait result");
    const original = (
      wait.result as {
        details: { completions: Array<{ results: Array<{ sessionFile: string }> }> };
      }
    ).details.completions[0].results[0].sessionFile;
    const fixture = readSubagentFixture(new URL("./fixtures/wait.json", import.meta.url), {
      from: original,
      to: fileURLToPath(new URL("./fixtures/child-session.jsonl", import.meta.url)),
    });
    const events = await verifySubagentFixture(fixture);
    const upserts = events
      .filter((event) => event.event.type === "upsert")
      .map((event) => (event.event.type === "upsert" ? event.event : null));
    // bg_wait settles the child; the later completion notice repeats it.
    expect(upserts.map((event) => event?.status)).toEqual([
      "running",
      "running",
      "completed",
      "completed",
    ]);
    expect(new Set(upserts.map((event) => event?.id)).size).toBe(1);
    expect(events.filter((event) => event.event.type === "timeline").length).toBeGreaterThan(0);
  });

  test("missing child file produces no timeline", async () => {
    expect(await mapPiChildSession("child", "/does-not-exist/pi-child.jsonl")).toEqual([]);
  });

  test("does not emit child timeline after session close", async () => {
    const raw = readSubagentFixture(new URL("./fixtures/foreground.json", import.meta.url));
    const completion = raw.events.find(
      (event) => event.type === "tool_execution_end" && event.toolName === "subagent",
    );
    if (!completion || completion.type !== "tool_execution_end") throw new Error("No completion");
    const original = (completion.result as { details: { results: Array<{ sessionFile: string }> } })
      .details.results[0].sessionFile;
    const fixture = readSubagentFixture(new URL("./fixtures/foreground.json", import.meta.url), {
      from: original,
      to: fileURLToPath(new URL("./fixtures/child-session.jsonl", import.meta.url)),
    });
    const pi = new FakePi();
    const client = new PiRpcAgentClient({ logger: pino({ level: "silent" }), runtime: pi });
    const session = await client.createSession({
      provider: "pi",
      cwd: "/tmp/paseo-pi-child-close",
    });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    await session.startTurn("Delegate work");
    for (const event of fixture.events) pi.latestSession().emit(event);
    await session.close();
    expect(
      events.some((event) => event.type === "provider_subagent" && event.event.type === "upsert"),
    ).toBe(true);
    expect(
      events.some((event) => event.type === "provider_subagent" && event.event.type === "timeline"),
    ).toBe(false);
  });

  test("a failed spawn without result rows finishes its descriptor", () => {
    const host = createPiExtensionHost();
    const args = { agent: "scout", task: "Inspect" };
    host.mapToolCall({
      callId: "failed",
      toolName: "subagent",
      args,
      status: "running",
      result: null,
    });
    expect(
      host.mapToolCall({
        callId: "failed",
        toolName: "subagent",
        args,
        status: "failed",
        result: { content: [{ type: "text", text: "spawn failed" }] },
      })?.subagents,
    ).toEqual([
      {
        type: "upsert",
        id: "failed",
        title: "scout",
        description: "Inspect",
        toolCallId: "failed",
        status: "failed",
      },
    ]);
  });

  test("maps a reconstructed workflowScript run to a live spawn row and its children", async () => {
    const fixture = readSubagentFixture(new URL("./fixtures/workflow.json", import.meta.url));
    const events = await verifySubagentFixture(fixture);
    const upserts = events
      .filter((event) => event.event.type === "upsert")
      .map((event) => (event.event.type === "upsert" ? event.event : null));
    expect(upserts.map((event) => [event?.id, event?.status])).toEqual([
      ["call_wf1", "running"],
      ["call_wf1", "running"],
      ["call_wf1:alpha", "completed"],
      ["call_wf1", "completed"],
    ]);
    // The workflow call carries no agent/task, so the script file names the run.
    expect(upserts[0]?.title).toBe("rigor-ui-test.js");
    expect(upserts[1]?.liveness).toBe("poll");
    expect(upserts[2]?.title).toBeUndefined();
  });

  test("maps a reported workflowScript run to its reviewer row and saved timeline", async () => {
    // Reported in #5837: `subagent({ workflow: true })` reaches the adapter as `workflowScript`,
    // not `workflow`, so a launch check keyed on `workflow` alone drops the whole run.
    const dir = await mkdtemp(join(tmpdir(), "paseo-pi-workflow-script-"));
    const host = createPiExtensionHost();
    try {
      const sessionFile = join(dir, "child.jsonl");
      await writeFile(
        sessionFile,
        JSON.stringify({
          type: "message",
          message: { role: "assistant", content: [{ type: "text", text: "README summary" }] },
        }) + "\n",
      );
      const args = {
        workflowScript:
          "return await runs.run('review', { agent: 'reviewer', task: 'Read README.md' });",
        async: false,
      };
      expect(
        host.mapToolCall({
          callId: "reported-workflow",
          toolName: "subagent",
          args,
          status: "running",
          result: null,
        })?.subagents,
      ).toEqual([
        expect.objectContaining({ id: "reported-workflow", title: "workflow", status: "running" }),
      ]);
      const output = host.mapToolCall({
        callId: "reported-workflow",
        toolName: "subagent",
        args,
        status: "completed",
        result: {
          details: {
            mode: "workflow",
            runId: "reported-run",
            results: [{ index: 0, agent: "reviewer", exitCode: 0, sessionFile }],
          },
        },
      });
      expect(output?.subagents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "upsert", title: "reviewer", status: "completed" }),
        ]),
      );
      expect(hasChildTimeline(await output!.hydration)).toBe(true);
    } finally {
      host.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("keys workflow child rows by their childKey while the run reports progress", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paseo-pi-workflow-"));
    const received: AgentStreamEvent[] = [];
    const host = createPiExtensionHost();
    try {
      host.follow((event) => received.push(event));
      host.mapToolCall({
        callId: "call-wf",
        toolName: "subagent",
        args: { workflow: "tmp/rigor-ui-test.js", async: true },
        status: "completed",
        result: {
          details: {
            mode: "workflow",
            runId: "run-wf",
            asyncId: "run-wf",
            asyncDir: dir,
            results: [],
          },
        },
      });
      await writeFile(
        join(dir, "status.json"),
        JSON.stringify({
          state: "running",
          steps: [
            { agent: "scout", workflowKey: "alpha", status: "complete" },
            { agent: "reviewer", workflowKey: "beta", status: "running" },
          ],
        }),
      );
      await expect.poll(() => reportedUpsert(received, "call-wf:beta")).toBe(true);
      expect(
        subagentUpserts(received).map((event) => [event.id, event.status, event.liveness]),
      ).toEqual(
        expect.arrayContaining([
          ["call-wf:alpha", "running", "poll"],
          ["call-wf:beta", "running", "poll"],
          ["call-wf", "running", "poll"],
        ]),
      );

      await writeFile(
        join(dir, "status.json"),
        JSON.stringify({
          state: "complete",
          steps: [
            { agent: "scout", workflowKey: "alpha", status: "complete" },
            { agent: "reviewer", workflowKey: "beta", status: "complete" },
          ],
        }),
      );
      await expect.poll(() => reportedUpsert(received, "call-wf", "completed")).toBe(true);
      expect(
        subagentUpserts(received).findLast((event) => event.id === "call-wf:alpha")?.status,
      ).toBe("completed");
    } finally {
      host.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("keeps a missing status directory's row alive until the miss budget expires", async () => {
    vi.useFakeTimers();
    const received: AgentStreamEvent[] = [];
    const host = createPiExtensionHost();
    try {
      host.follow((event) => received.push(event));
      host.mapToolCall({
        callId: "call-lost",
        toolName: "subagent",
        args: { agent: "scout", task: "Inspect", async: true },
        status: "completed",
        result: {
          details: {
            mode: "single",
            runId: "run-1",
            asyncId: "run-1",
            asyncDir: "/nonexistent",
            results: [],
          },
        },
      });
      await vi.advanceTimersByTimeAsync(250 * 5);
      // The run is alive even while its file is missing: every miss tick re-reports the row, or a
      // turn end inside the miss budget would cancel live work.
      const duringMisses = subagentUpserts(received);
      expect(duringMisses.length).toBeGreaterThanOrEqual(5);
      expect(duringMisses.every((event) => event.status === "running")).toBe(true);
      expect(duringMisses.every((event) => event.liveness === "poll")).toBe(true);

      // 60 s of missing ticks, the budget before a status directory counts as gone.
      await vi.advanceTimersByTimeAsync(250 * 236);
      // The launch row comes back through the caller; polling reports the give-up exactly once.
      const afterGiveUp = subagentUpserts(received);
      expect(afterGiveUp.findLast((event) => event.id === "call-lost")).toEqual({
        type: "upsert",
        id: "call-lost",
        status: "canceled",
        liveness: "poll",
      });
      expect(afterGiveUp.filter((event) => event.status === "canceled")).toHaveLength(1);
    } finally {
      host.close();
      vi.useRealTimers();
    }
  });

  test("a completion notice stops polling so a stale status file cannot revert the card", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paseo-pi-stale-"));
    const received: AgentStreamEvent[] = [];
    const host = createPiExtensionHost();
    try {
      host.follow((event) => received.push(event));
      host.mapToolCall({
        callId: "call-1",
        toolName: "subagent",
        args: { agent: "scout", task: "Inspect", async: true },
        status: "completed",
        result: {
          details: { mode: "single", runId: "run-1", asyncId: "run-1", asyncDir: dir, results: [] },
        },
      });
      await writeFile(
        join(dir, "status.json"),
        JSON.stringify({ state: "running", steps: [{ agent: "scout", status: "running" }] }),
      );
      const statuses = () =>
        received.flatMap((event) =>
          event.type === "provider_subagent" && event.event.type === "upsert"
            ? [event.event.status]
            : [],
        );
      await expect.poll(() => statuses().length).toBeGreaterThan(1);

      host.mapCustomMessage({
        role: "custom",
        customType: "subagent-notify",
        content: [
          "Background task completed: **scout**",
          "",
          `Retention-managed async directory: ${dir}`,
        ].join("\n"),
      });
      const settled = statuses().length;

      // The run's directory is still on disk with a running status; polling must stay off.
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(statuses().length).toBe(settled);
    } finally {
      host.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a bg_wait result keeps its verdict while the run's status names no child yet", async () => {
    vi.useFakeTimers();
    const dir = await mkdtemp(join(tmpdir(), "paseo-pi-settled-owner-"));
    const received: AgentStreamEvent[] = [];
    const host = createPiExtensionHost();
    try {
      host.follow((event) => received.push(event));
      host.mapToolCall({
        callId: "call-1",
        toolName: "subagent",
        args: { agent: "scout", task: "Inspect", async: true },
        status: "completed",
        result: {
          details: { mode: "single", runId: "run-1", asyncId: "run-1", asyncDir: dir, results: [] },
        },
      });
      // A single unnamed child takes the owner's id, so this result settles the launch row while the
      // run itself keeps polling.
      expect(
        host.mapToolCall({
          callId: "wait-1",
          toolName: "bg_wait",
          args: { runId: "run-1" },
          status: "completed",
          result: {
            details: {
              mode: "single",
              results: [],
              completions: [
                { runId: "run-1", results: [{ agent: "scout", success: true, exitCode: 0 }] },
              ],
            },
          },
        })?.subagents,
      ).toEqual([expect.objectContaining({ id: "call-1", status: "completed" })]);

      // The queue has not started the child yet, so the status file names no step: that tick must
      // not re-report the owner as running over the verdict it already has.
      await writeFile(join(dir, "status.json"), JSON.stringify({ state: "running", steps: [] }));
      const beforeTick = received.length;
      await vi.advanceTimersByTimeAsync(250 * 2);

      expect(subagentUpserts(received.slice(beforeTick))).toEqual([]);
    } finally {
      host.close();
      vi.useRealTimers();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a paused run settles as canceled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paseo-pi-paused-"));
    const host = createPiExtensionHost();
    try {
      host.mapToolCall({
        callId: "call-1",
        toolName: "subagent",
        args: { agent: "scout", task: "Inspect", async: true },
        status: "completed",
        result: {
          details: { mode: "single", runId: "run-1", asyncId: "run-1", asyncDir: dir, results: [] },
        },
      });
      expect(
        host.mapCustomMessage({
          role: "custom",
          customType: "subagent-notify",
          content: [
            "Background task paused: **scout**",
            "",
            `Retention-managed async directory: ${dir}`,
          ].join("\n"),
        })?.subagents,
      ).toEqual([{ type: "upsert", id: "call-1", status: "canceled" }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a paused workflow child notice settles its row as canceled", () => {
    const host = createPiExtensionHost();
    host.mapToolCall({
      callId: "call-wf",
      toolName: "subagent",
      args: { workflow: "tmp/rigor-ui-test.js", async: true },
      status: "completed",
      result: {
        details: {
          mode: "workflow",
          runId: "run-wf",
          asyncId: "run-wf",
          asyncDir: "/nonexistent",
          results: [],
        },
      },
    });
    expect(
      host.mapCustomMessage({
        role: "custom",
        customType: "subagent-incremental-child-notify",
        content: "Workflow child paused (needs attention): **alpha**\nWorkflow run: run-wf",
      })?.subagents,
    ).toEqual([{ type: "upsert", id: "call-wf:alpha", status: "canceled" }]);
  });

  test("partial and rejected runs settle every child instead of leaving a spinner", async () => {
    for (const [state, expected] of [
      ["partial", ["completed", "completed", "canceled"]],
      ["rejected", ["completed", "completed", "failed"]],
    ] as const) {
      vi.useFakeTimers();
      const dir = await mkdtemp(join(tmpdir(), "paseo-pi-partial-"));
      const received: AgentStreamEvent[] = [];
      const host = createPiExtensionHost();
      try {
        host.mapToolCall({
          callId: "call-wf",
          toolName: "subagent",
          args: { workflow: "tmp/rigor-ui-test.js", async: true },
          status: "completed",
          result: {
            details: {
              mode: "workflow",
              runId: "run-wf",
              asyncId: "run-wf",
              asyncDir: dir,
              results: [],
            },
          },
        });
        await writeFile(
          join(dir, "status.json"),
          JSON.stringify({
            state,
            steps: [
              { agent: "scout", workflowKey: "alpha", status: "complete" },
              // WorkflowNodeStatus spells the same outcome `completed`.
              { agent: "auditor", workflowKey: "gamma", status: "completed" },
              {
                agent: "reviewer",
                workflowKey: "beta",
                status: state === "partial" ? "running" : "failed",
              },
            ],
          }),
        );
        host.follow((event) => received.push(event));
        await vi.advanceTimersByTimeAsync(250);

        expect(subagentUpserts(received).map((event) => [event.id, event.status])).toEqual(
          expect.arrayContaining([
            ["call-wf:alpha", expected[0]],
            ["call-wf:gamma", expected[1]],
            ["call-wf:beta", expected[2]],
            ["call-wf", "canceled"],
          ]),
        );
        expect(
          subagentUpserts(received).filter((event) => event.status === "running"),
        ).toHaveLength(0);

        // The run is terminal, so the poll stops instead of re-reporting fresh rows.
        const settled = received.length;
        await vi.advanceTimersByTimeAsync(250 * 4);
        expect(received.length).toBe(settled);
      } finally {
        host.close();
        vi.useRealTimers();
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  test("a child notice keeps its status while the run is still reporting", async () => {
    vi.useFakeTimers();
    const dir = await mkdtemp(join(tmpdir(), "paseo-pi-notice-pin-"));
    const received: AgentStreamEvent[] = [];
    const host = createPiExtensionHost();
    try {
      host.mapToolCall({
        callId: "call-wf",
        toolName: "subagent",
        args: { workflow: "tmp/rigor-ui-test.js", async: true },
        status: "completed",
        result: {
          details: {
            mode: "workflow",
            runId: "run-wf",
            asyncId: "run-wf",
            asyncDir: dir,
            results: [],
          },
        },
      });
      // The stale step entry still says running; the child's notice is its verdict.
      await writeFile(
        join(dir, "status.json"),
        JSON.stringify({
          state: "running",
          steps: [
            { agent: "scout", workflowKey: "alpha", status: "complete" },
            { agent: "reviewer", workflowKey: "beta", status: "running" },
          ],
        }),
      );
      host.follow((event) => received.push(event));
      await vi.advanceTimersByTimeAsync(250);
      expect(
        host.mapCustomMessage({
          role: "custom",
          customType: "subagent-incremental-child-notify",
          content: "Workflow child completed: **alpha**\nWorkflow run: run-wf",
        })?.subagents,
      ).toEqual([{ type: "upsert", id: "call-wf:alpha", status: "completed" }]);

      const beforeNotice = received.length;
      await vi.advanceTimersByTimeAsync(250 * 3);
      expect(
        subagentUpserts(received.slice(beforeNotice)).filter(
          (event) => event.id === "call-wf:alpha",
        ),
      ).toEqual([]);
      // The rest of the run keeps re-reporting, so this is not a poll that simply stopped.
      expect(reportedUpsert(received.slice(beforeNotice), "call-wf:beta")).toBe(true);
    } finally {
      host.close();
      vi.useRealTimers();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a child notice's verdict survives the run's terminal tick", async () => {
    vi.useFakeTimers();
    const dir = await mkdtemp(join(tmpdir(), "paseo-pi-notice-terminal-"));
    const received: AgentStreamEvent[] = [];
    const host = createPiExtensionHost();
    try {
      host.mapToolCall({
        callId: "call-wf",
        toolName: "subagent",
        args: { workflow: "tmp/rigor-ui-test.js", async: true },
        status: "completed",
        result: {
          details: {
            mode: "workflow",
            runId: "run-wf",
            asyncId: "run-wf",
            asyncDir: dir,
            results: [],
          },
        },
      });
      host.follow((event) => received.push(event));
      // The child's notice settles it before the run itself ends.
      expect(
        host.mapCustomMessage({
          role: "custom",
          customType: "subagent-incremental-child-notify",
          content: "Workflow child completed: **alpha**\nWorkflow run: run-wf",
        })?.subagents,
      ).toEqual([{ type: "upsert", id: "call-wf:alpha", status: "completed" }]);

      // The run then ends without a verdict for alpha: its step entry still says running, which the
      // terminal tick would read as canceled if the notice were not the child's verdict.
      await writeFile(
        join(dir, "status.json"),
        JSON.stringify({
          state: "stopped",
          steps: [
            { agent: "scout", workflowKey: "alpha", status: "running" },
            { agent: "reviewer", workflowKey: "beta", status: "stopped" },
          ],
        }),
      );
      await vi.advanceTimersByTimeAsync(250);

      expect(
        subagentUpserts(received).filter((event) => event.id === "call-wf:alpha" && event.status),
      ).toEqual([]);
      // The child that never reported a verdict of its own is still settled by that tick.
      expect(
        subagentUpserts(received).findLast((event) => event.id === "call-wf:beta")?.status,
      ).toBe("canceled");
    } finally {
      host.close();
      vi.useRealTimers();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("gives up without rewriting a child that already settled", async () => {
    vi.useFakeTimers();
    const dir = await mkdtemp(join(tmpdir(), "paseo-pi-giveup-"));
    const received: AgentStreamEvent[] = [];
    const host = createPiExtensionHost();
    try {
      host.mapToolCall({
        callId: "call-wf",
        toolName: "subagent",
        args: { workflow: "tmp/rigor-ui-test.js", async: true },
        status: "completed",
        result: {
          details: {
            mode: "workflow",
            runId: "run-wf",
            asyncId: "run-wf",
            asyncDir: dir,
            results: [],
          },
        },
      });
      await writeFile(
        join(dir, "status.json"),
        JSON.stringify({
          state: "running",
          steps: [
            { agent: "scout", workflowKey: "alpha", status: "complete" },
            { agent: "reviewer", workflowKey: "beta", status: "running" },
          ],
        }),
      );
      host.follow((event) => received.push(event));
      await vi.advanceTimersByTimeAsync(250);
      expect(reportedUpsert(received, "call-wf:beta")).toBe(true);

      // The workflow keeps running, so polling continues after the child's own notice.
      expect(
        host.mapCustomMessage({
          role: "custom",
          customType: "subagent-incremental-child-notify",
          content: "Workflow child completed: **alpha**\nWorkflow run: run-wf",
        })?.subagents,
      ).toEqual([{ type: "upsert", id: "call-wf:alpha", status: "completed" }]);

      await rm(join(dir, "status.json"));
      await vi.advanceTimersByTimeAsync(250 * 241);

      expect(
        subagentUpserts(received).some(
          (event) => event.id === "call-wf:alpha" && event.status === "canceled",
        ),
      ).toBe(false);
      expect(
        subagentUpserts(received).findLast((event) => event.id === "call-wf:beta")?.status,
      ).toBe("canceled");
    } finally {
      host.close();
      vi.useRealTimers();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a run's final notice cancels the children it stopped with", async () => {
    vi.useFakeTimers();
    const dir = await mkdtemp(join(tmpdir(), "paseo-pi-stopped-children-"));
    const received: AgentStreamEvent[] = [];
    const host = createPiExtensionHost();
    try {
      host.mapToolCall({
        callId: "call-wf",
        toolName: "subagent",
        args: { workflow: "tmp/rigor-ui-test.js", async: true },
        status: "completed",
        result: {
          details: {
            mode: "workflow",
            runId: "run-wf",
            asyncId: "run-wf",
            asyncDir: dir,
            results: [],
          },
        },
      });
      await writeFile(
        join(dir, "status.json"),
        JSON.stringify({
          state: "running",
          steps: [
            { agent: "scout", workflowKey: "alpha", status: "running" },
            { agent: "reviewer", workflowKey: "beta", status: "running" },
          ],
        }),
      );
      host.follow((event) => received.push(event));
      await vi.advanceTimersByTimeAsync(250);
      expect(reportedUpsert(received, "call-wf:beta")).toBe(true);

      // alpha reports its own verdict before the run stops.
      expect(
        host.mapCustomMessage({
          role: "custom",
          customType: "subagent-incremental-child-notify",
          content: "Workflow child completed: **alpha**\nWorkflow run: run-wf",
        })?.subagents,
      ).toEqual([{ type: "upsert", id: "call-wf:alpha", status: "completed" }]);

      // The run then stops with beta unfinished. The notice ends the poll, so no later tick will
      // ever report beta: it settles as canceled, never completed. alpha keeps its own verdict.
      expect(
        host.mapCustomMessage({
          role: "custom",
          customType: "subagent-notify",
          content: [
            "Background task stopped: **rigor-ui-test.js**",
            "",
            `Retention-managed async directory: ${dir}`,
          ].join("\n"),
        })?.subagents,
      ).toEqual([
        { type: "upsert", id: "call-wf", status: "canceled" },
        { type: "upsert", id: "call-wf:beta", status: "canceled" },
      ]);

      // Polling is off; the status file still says running and must not bring the rows back.
      const settled = received.length;
      await vi.advanceTimersByTimeAsync(250 * 3);
      expect(received.length).toBe(settled);
    } finally {
      host.close();
      vi.useRealTimers();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("names a child a notice settled before the first poll saw it", async () => {
    vi.useFakeTimers();
    const dir = await mkdtemp(join(tmpdir(), "paseo-pi-fast-child-"));
    const received: AgentStreamEvent[] = [];
    const host = createPiExtensionHost();
    try {
      host.mapToolCall({
        callId: "call-wf",
        toolName: "subagent",
        args: { workflow: "tmp/rigor-ui-test.js", async: true },
        status: "completed",
        result: {
          details: {
            mode: "workflow",
            runId: "run-wf",
            asyncId: "run-wf",
            asyncDir: dir,
            results: [],
          },
        },
      });
      // A fast child reports before any poll tick, so its row is born without a name.
      expect(
        host.mapCustomMessage({
          role: "custom",
          customType: "subagent-incremental-child-notify",
          content: "Workflow child completed: **alpha**\nWorkflow run: run-wf",
        })?.subagents,
      ).toEqual([{ type: "upsert", id: "call-wf:alpha", status: "completed" }]);

      await writeFile(
        join(dir, "status.json"),
        JSON.stringify({
          state: "running",
          steps: [{ agent: "scout", workflowKey: "alpha", status: "running" }],
        }),
      );
      host.follow((event) => received.push(event));
      await vi.advanceTimersByTimeAsync(250);

      // The poll leaves the settled status alone but still fills the name status.json carries.
      const alphaUpserts = () =>
        subagentUpserts(received).filter((event) => event.id === "call-wf:alpha");
      expect(alphaUpserts()).toEqual([
        { type: "upsert", id: "call-wf:alpha", title: "scout", liveness: "poll" },
      ]);

      // Reported once, not on every tick.
      await vi.advanceTimersByTimeAsync(250 * 2);
      expect(alphaUpserts()).toHaveLength(1);
    } finally {
      host.close();
      vi.useRealTimers();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a workflow that reported rows replaces its placeholder with them", () => {
    const host = createPiExtensionHost();
    const args = { workflow: true };
    // The in-flight placeholder is poll-marked, so a turn end can settle it if its call never
    // reports back.
    expect(
      host.mapToolCall({
        callId: "fanout",
        toolName: "subagent",
        args,
        status: "running",
        result: null,
      })?.subagents,
    ).toEqual([expect.objectContaining({ id: "fanout", status: "running", liveness: "poll" })]);
    expect(
      host.mapToolCall({
        callId: "fanout",
        toolName: "subagent",
        args,
        status: "completed",
        result: {
          details: {
            mode: "workflow",
            results: [
              { index: 0, agent: "scout", workflowKey: "alpha", success: true, exitCode: 0 },
              { index: 1, agent: "reviewer", workflowKey: "beta", success: true, exitCode: 0 },
            ],
          },
        },
      })?.subagents,
    ).toEqual([
      { type: "remove", id: "fanout" },
      expect.objectContaining({ id: "fanout:alpha", title: "scout", status: "completed" }),
      expect.objectContaining({ id: "fanout:beta", title: "reviewer", status: "completed" }),
    ]);
  });
});
