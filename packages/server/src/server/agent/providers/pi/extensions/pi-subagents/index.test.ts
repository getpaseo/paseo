import { describe, expect, test } from "vitest";
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
});
