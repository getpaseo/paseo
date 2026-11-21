import { describe, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { createPiExtensionHost } from "../index.js";
import { readSubagentFixture, verifySubagentFixture } from "../subagent-fixture-test.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { edxethPiSubagents } from "./index.js";
import { streamPiHistory } from "../../history-mapper.js";
import { ProviderSubagentStore } from "../../../../provider-subagents/store.js";

const args = {
  agent: "scout",
  name: "status-scout",
  title: "Check child status",
  task: "Return the completion marker",
};

describe("edxeth/pi-subagents adapter", () => {
  test.each(["tool", "notification"])("ends a child that requested help via %s", (delivery) => {
    const host = createPiExtensionHost();
    const call = { callId: "spawn-1", toolName: "subagent", args, status: "completed" as const };
    host.mapToolCall({
      ...call,
      result: { details: { id: "run-1", name: args.name, status: "started" } },
    });
    const details = { id: "run-1", name: args.name, message: "Please clarify the task" };
    const result =
      delivery === "tool"
        ? host.mapToolCall({ ...call, result: { details: { ...details, status: "pinged" } } })
        : host.mapCustomMessage({
            role: "custom",
            customType: "subagent_ping",
            content: "Child requested help and exited",
            details,
          });
    expect(result?.subagents).toEqual([
      expect.objectContaining({
        type: "upsert",
        id: "spawn-1",
        status: "canceled",
        subtitle: "Needs help",
      }),
    ]);
  });

  test("leaves unrelated tools and other subagent protocols to their adapters", () => {
    const host = createPiExtensionHost(undefined, [edxethPiSubagents]);
    const call = { callId: "other", toolName: "subagent", args, status: "completed" as const };
    for (const details of [null, {}, { mode: "single", results: [] }, { id: "run-1" }]) {
      expect(host.mapToolCall({ ...call, result: { details } })).toBeUndefined();
    }
    expect(
      host.mapToolCall({
        ...call,
        toolName: "unrelated",
        result: { details: { id: "run-1", name: args.name, status: "completed" } },
      }),
    ).toBeUndefined();
    for (const details of [{ id: "run-1" }, { id: "run-1", status: "unknown" }]) {
      expect(
        host.mapCustomMessage({
          role: "custom",
          customType: "subagent_result",
          content: "Unrecognized result",
          details,
        }),
      ).toBeUndefined();
    }
  });

  test("waits for cancellation after a kill acknowledgement reports stopping", () => {
    const host = createPiExtensionHost();
    host.mapToolCall({
      callId: "spawn-1",
      toolName: "subagent",
      args,
      status: "completed",
      result: { details: { id: "run-1", name: args.name, status: "started" } },
    });
    const stopping = host.mapToolCall({
      callId: "kill-1",
      toolName: "subagent_kill",
      args: { id: "run-1" },
      status: "completed",
      result: { details: { id: "run-1", name: args.name, status: "stopping" } },
    });
    expect(stopping?.subagents ?? []).toEqual([]);
    expect(
      host.mapCustomMessage({
        role: "custom",
        customType: "subagent_result",
        content: "Cancelled",
        details: { id: "run-1", status: "cancelled" },
      })?.subagents,
    ).toEqual([{ type: "upsert", id: "spawn-1", status: "canceled" }]);
  });

  test("preserves a completion that arrives before its launch acknowledgement", () => {
    const host = createPiExtensionHost();
    const early = host.mapCustomMessage({
      role: "custom",
      customType: "subagent_result",
      content: "Already done",
      details: { id: "fast-run", status: "completed" },
    });
    expect(early?.subagents ?? []).toEqual([]);
    const started = host.mapToolCall({
      callId: "fast-call",
      toolName: "subagent",
      args,
      status: "completed",
      result: {
        details: { id: "fast-run", name: args.name, agent: args.agent, status: "started" },
      },
    });
    expect(started?.subagents).toEqual([
      {
        type: "upsert",
        id: "fast-call",
        title: "scout",
        description: args.task,
        toolCallId: "fast-call",
        status: "completed",
      },
    ]);
  });

  test.each([
    { details: { status: "completed" }, expected: "completed" },
    { details: { status: "failed" }, expected: "failed" },
    { details: { status: "cancelled" }, expected: "canceled" },
    { details: { error: "Child watcher exited unexpectedly" }, expected: "failed" },
  ])("maps completion $details to $expected", ({ details, expected }) => {
    const host = createPiExtensionHost();
    host.mapToolCall({
      callId: "spawn-1",
      toolName: "subagent",
      args,
      status: "completed",
      result: { details: { id: "run-1", name: args.name, status: "started" } },
    });
    expect(
      host.mapCustomMessage({
        role: "custom",
        customType: "subagent_result",
        content: "Child result",
        details: { id: "run-1", ...details },
      })?.subagents,
    ).toEqual([{ type: "upsert", id: "spawn-1", status: expected }]);
  });

  test("a resume gets its own run and reads the retained child session", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paseo-edxeth-resume-"));
    const file = join(dir, "child.jsonl");
    const host = createPiExtensionHost();
    try {
      await writeFile(
        file,
        JSON.stringify({
          type: "message",
          message: { role: "assistant", content: [{ type: "text", text: "RESUMED" }] },
        }) + "\n",
      );
      const original = host.mapToolCall({
        callId: "spawn-1",
        toolName: "subagent",
        args,
        status: "completed",
        result: {
          details: { id: "run-1", name: args.name, status: "completed", sessionFile: file },
        },
      });
      await original?.hydration;
      const resumed = host.mapToolCall({
        callId: "resume-1",
        toolName: "subagent_resume",
        args: { sessionFile: file, task: "Continue" },
        status: "completed",
        result: {
          details: { id: "run-2", name: args.name, status: "started", sessionFile: file },
        },
      });
      expect(resumed?.childSessions).toEqual([{ id: "resume-1", file }]);
      expect(await resumed?.hydration).toEqual([
        {
          type: "provider_subagent",
          provider: "pi",
          event: {
            type: "timeline",
            id: "resume-1",
            item: expect.objectContaining({ type: "assistant_message", text: "RESUMED" }),
          },
        },
      ]);
      expect(
        host.mapCustomMessage({
          role: "custom",
          customType: "subagent_result",
          content: "Resumed run complete",
          details: { id: "run-2", status: "completed", sessionFile: file },
        })?.subagents,
      ).toEqual([{ type: "upsert", id: "resume-1", status: "completed" }]);
    } finally {
      host.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("settles each batched child by run id without creating a parent-call card", () => {
    const host = createPiExtensionHost();
    const result = host.mapToolCall({
      callId: "batch-1",
      toolName: "subagent",
      args: { children: [args, { ...args, agent: "reviewer", name: "status-reviewer" }] },
      status: "completed",
      result: {
        details: {
          status: "batch",
          children: [
            { id: "run-1", ...args, mode: "background", status: "completed" },
            { id: "run-2", name: "status-reviewer", agent: "reviewer", status: "started" },
          ],
        },
      },
    });
    expect(result?.subagents).toEqual([
      {
        type: "upsert",
        id: "batch-1:0",
        title: "scout",
        description: args.task,
        toolCallId: "batch-1",
        status: "completed",
      },
      {
        type: "upsert",
        id: "batch-1:1",
        title: "reviewer",
        description: undefined,
        toolCallId: "batch-1",
        status: "running",
      },
    ]);
    expect(
      host.mapCustomMessage({
        role: "custom",
        customType: "subagent_result",
        content: "Done",
        details: { id: "run-2", status: "completed" },
      })?.subagents,
    ).toEqual([{ type: "upsert", id: "batch-1:1", status: "completed" }]);
  });

  test.each([
    { mode: "foreground", statuses: ["running", "completed"] },
    { mode: "background", statuses: ["running", "running", "completed"] },
  ])("settles the captured $mode run live and on replay", async ({ mode, statuses }) => {
    const fixture = readSubagentFixture(new URL(`./fixtures/${mode}.json`, import.meta.url), {
      from: `/tmp/paseo-edxeth-fixture/${mode}/child-session.jsonl`,
      to: fileURLToPath(new URL(`./fixtures/${mode}-child-session.jsonl`, import.meta.url)),
    });
    const events = await verifySubagentFixture(fixture);
    const updates = events.flatMap(({ event }) => (event.type === "upsert" ? [event] : []));
    expect(updates.map((event) => event.status)).toEqual(statuses);
    expect(new Set(updates.map((event) => event.id)).size).toBe(1);
    expect(events.some(({ event }) => event.type === "timeline")).toBe(true);
  });

  test.each(["foreground", "background"])(
    "restores a completed %s child and its transcript to the consumer store",
    async (mode) => {
      const fixture = readSubagentFixture(new URL(`./fixtures/${mode}.json`, import.meta.url), {
        from: `/tmp/paseo-edxeth-fixture/${mode}/child-session.jsonl`,
        to: fileURLToPath(new URL(`./fixtures/${mode}-child-session.jsonl`, import.meta.url)),
      });
      const store = new ProviderSubagentStore();
      for await (const event of streamPiHistory("pi", fixture.messages)) {
        if (event.type === "provider_subagent") store.apply("parent", "pi", event.event);
      }
      const children = store.list("parent");
      expect(children).toEqual([expect.objectContaining({ status: "completed", title: "marker" })]);
      const transcript = store.fetchTimeline("parent", children[0]!.id);
      expect(transcript.rows).toContainEqual(
        expect.objectContaining({
          item: expect.objectContaining({
            type: "assistant_message",
            text: mode === "foreground" ? "PASEO_EDXETH_UPSTREAM_OK" : "PASEO_EDXETH_LEAN_OK",
          }),
        }),
      );
    },
  );

  test("settles a synchronous result on the card created when the tool started", () => {
    const host = createPiExtensionHost();
    const call = { callId: "spawn-1", toolName: "subagent", args };
    const start = host.mapToolCall({ ...call, status: "running", result: null });
    expect(start?.subagents).toEqual([
      {
        type: "upsert",
        id: "spawn-1",
        title: "scout",
        description: args.task,
        toolCallId: "spawn-1",
        status: "running",
      },
    ]);
    const end = host.mapToolCall({
      ...call,
      status: "completed",
      result: {
        content: [{ type: "text", text: "DONE" }],
        details: {
          id: "run-1",
          name: args.name,
          agent: args.agent,
          mode: "background",
          status: "completed",
          deliveryState: "awaited",
          exitCode: 0,
        },
      },
    });
    expect(end?.subagents).toEqual([
      {
        type: "upsert",
        id: "spawn-1",
        title: "scout",
        description: args.task,
        toolCallId: "spawn-1",
        status: "completed",
      },
    ]);
  });
});
