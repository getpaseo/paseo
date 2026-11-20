import { describe, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { mkdtemp, writeFile, appendFile, rm, mkdir } from "node:fs/promises";
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

function hasChildTimeline(events: AgentStreamEvent[], id?: string) {
  return events.some(
    (event) =>
      event.type === "provider_subagent" &&
      event.event.type === "timeline" &&
      (!id || event.event.id === id),
  );
}

function childAssistantTexts(events: AgentStreamEvent[], id: string) {
  return events.flatMap((event) => {
    if (
      event.type === "provider_subagent" &&
      event.event.type === "timeline" &&
      event.event.id === id &&
      event.event.item.type === "assistant_message"
    )
      return [event.event.item.text];
    return [];
  });
}

function lastChildUpsert(events: AgentStreamEvent[], id: string) {
  const last = events.findLast(
    (event) =>
      event.type === "provider_subagent" && event.event.type === "upsert" && event.event.id === id,
  );
  return last?.type === "provider_subagent" ? last.event : undefined;
}

function hasCompletedChild(events: AgentStreamEvent[]) {
  return events.some(
    (event) =>
      event.type === "provider_subagent" &&
      event.event.type === "upsert" &&
      event.event.status === "completed",
  );
}

describe("pi-subagents adapter", () => {
  test("registers a successful resume as a new async attempt without spawn arguments", () => {
    const host = createPiExtensionHost();
    const resumed = host.mapToolCall({
      callId: "resume-b",
      toolName: "subagent",
      args: { action: "resume", id: "run-a", message: "Continue" },
      status: "completed",
      result: {
        details: {
          mode: "single",
          runId: "run-b",
          asyncId: "run-b",
          asyncDir: "/tmp/paseo-resume-b",
          results: [],
        },
      },
    });
    expect(resumed?.subagents).toEqual([
      {
        type: "upsert",
        id: "resume-b",
        title: "Subagent",
        description: "Continue",
        toolCallId: "resume-b",
        status: "running",
      },
    ]);
  });
  test.each([
    { action: "resume", status: "running" as const, mode: "single" },
    { action: "resume", status: "failed" as const, mode: "single" },
    { action: "resume", status: "completed" as const, mode: "management" },
    { action: "status", status: "completed" as const, mode: "single" },
    { action: "steer", status: "completed" as const, mode: "single" },
  ])("does not create phantom rows for $action/$status/$mode", ({ action, status, mode }) => {
    expect(
      createPiExtensionHost().mapToolCall({
        callId: "management",
        toolName: "subagent",
        args: { action, id: "run-a", message: "Continue" },
        status,
        result: {
          details: { mode, asyncId: "run-b", asyncDir: "/tmp/paseo-resume-b", results: [] },
        },
      }),
    ).toBeUndefined();
  });

  test.each([
    { mode: "single", results: [] },
    { mode: "single", asyncId: "run-b", results: [] },
    { mode: "single", asyncDir: "/tmp/paseo-resume-b", results: [] },
    {
      mode: "single",
      asyncId: "run-b",
      asyncDir: "/tmp/paseo-resume-b",
      results: [{ agent: "scout", exitCode: 0 }],
    },
  ])("does not register a resume without a new async launch: %j", (details) => {
    expect(
      createPiExtensionHost().mapToolCall({
        callId: "not-launched",
        toolName: "subagent",
        args: { action: "resume", id: "run-a", message: "Continue" },
        status: "completed",
        result: { details },
      }),
    ).toBeUndefined();
  });

  test("uses the resume task alias as the follow-up description", () => {
    expect(
      createPiExtensionHost().mapToolCall({
        callId: "resume-task",
        toolName: "subagent",
        args: { action: "resume", id: "source-prefix", task: "Continue via task" },
        status: "completed",
        result: {
          details: {
            mode: "single",
            asyncId: "run-b",
            asyncDir: "/tmp/paseo-resume-b",
            results: [],
          },
        },
      })?.subagents,
    ).toEqual([
      expect.objectContaining({
        id: "resume-task",
        description: "Continue via task",
        status: "running",
      }),
    ]);
  });

  test("follows consecutive resumed attempts and keeps stale notices on their own rows", async () => {
    const root = await mkdtemp(join(tmpdir(), "paseo-pi-resume-"));
    const host = createPiExtensionHost();
    const replay = createPiExtensionHost();
    const received: AgentStreamEvent[] = [];
    try {
      host.follow((event) => received.push(event));
      const initialTexts: string[] = [];
      for (const [run, source] of [
        ["b", "a"],
        ["c", "b"],
      ]) {
        const dir = join(root, run);
        const file = join(root, "shared-child.jsonl");
        await mkdir(dir);
        await appendFile(
          file,
          JSON.stringify({
            type: "message",
            message: { role: "assistant", content: [{ type: "text", text: `Attempt ${run}` }] },
          }) + "\n",
        );
        await writeFile(
          join(dir, "status.json"),
          JSON.stringify({
            state: "running",
            revivedFrom: `run-${source}`,
            steps: [{ agent: "scout", status: "running", sessionFile: file }],
          }),
        );
        const call = {
          callId: `resume-${run}`,
          toolName: "subagent",
          args: { action: "resume", id: `run-${source}`, message: `Continue ${run}` },
          status: "completed" as const,
          result: {
            details: {
              mode: "single",
              runId: `run-${run}`,
              asyncId: `run-${run}`,
              asyncDir: dir,
              results: [],
            },
          },
        };
        expect(host.mapToolCall(call)?.subagents).toEqual([
          expect.objectContaining({ id: `resume-${run}`, status: "running" }),
        ]);
        replay.mapToolCall(call);
        initialTexts.push(`Attempt ${run}`);
        await expect
          .poll(() => childAssistantTexts(received, `resume-${run}`))
          .toEqual(initialTexts);
      }
      const oldNotice = {
        role: "custom" as const,
        customType: "subagent-notify",
        content: `Background task completed: **scout**\nRetention-managed async directory: ${join(root, "b")}\nSession file: ${join(root, "shared-child.jsonl")}`,
      };
      expect(host.mapCustomMessage(oldNotice)?.subagents).toEqual([
        { type: "upsert", id: "resume-b", status: "completed" },
      ]);
      const oldReplay = replay.mapCustomMessage(oldNotice);
      expect(oldReplay?.subagents).toEqual([
        { type: "upsert", id: "resume-b", status: "completed" },
      ]);
      expect(hasChildTimeline(await oldReplay!.hydration)).toBe(true);
      expect(lastChildUpsert(received, "resume-c")).toEqual({
        type: "upsert",
        id: "resume-c",
        title: "scout",
        status: "running",
      });
      await appendFile(
        join(root, "shared-child.jsonl"),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Attempt c follow-up" }],
          },
        }) + "\n",
      );
      const expectedCTexts = ["Attempt b", "Attempt c", "Attempt c follow-up"];
      await expect.poll(() => childAssistantTexts(received, "resume-c")).toEqual(expectedCTexts);
      expect(lastChildUpsert(received, "resume-c")).toEqual({
        type: "upsert",
        id: "resume-c",
        title: "scout",
        status: "running",
      });
      await writeFile(
        join(root, "c", "status.json"),
        JSON.stringify({
          state: "complete",
          steps: [
            { agent: "scout", status: "complete", sessionFile: join(root, "shared-child.jsonl") },
          ],
        }),
      );
      await expect
        .poll(() => lastChildUpsert(received, "resume-c"))
        .toEqual(expect.objectContaining({ status: "completed" }));
      const notice = replay.mapCustomMessage({
        ...oldNotice,
        content: `Background task completed: **scout**\nRetention-managed async directory: ${join(root, "c")}\nSession file: ${join(root, "shared-child.jsonl")}`,
      });
      expect(notice?.subagents).toEqual([{ type: "upsert", id: "resume-c", status: "completed" }]);
      const hydration = await notice!.hydration;
      expect(childAssistantTexts(hydration, "resume-c")).toEqual(expectedCTexts);
      expect(hydration).toEqual(
        expectedCTexts.map((text) => ({
          type: "provider_subagent",
          provider: "pi",
          event: {
            type: "timeline",
            id: "resume-c",
            item: expect.objectContaining({ type: "assistant_message", text }),
          },
        })),
      );
      expect(
        host.mapToolCall({
          callId: "wait-c",
          toolName: "bg_wait",
          args: {},
          status: "completed",
          result: {
            details: {
              mode: "wait",
              results: [],
              completions: [{ runId: "run-c", results: [{ agent: "scout", exitCode: 0 }] }],
            },
          },
        })?.subagents,
      ).toEqual([expect.objectContaining({ id: "resume-c", status: "completed" })]);
    } finally {
      host.close();
      replay.close();
      await rm(root, { recursive: true, force: true });
    }
  });

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
      log: "",
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
});
