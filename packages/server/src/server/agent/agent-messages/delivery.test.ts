import { AgentTurnBusyError, AgentTurnChangedError } from "../agent-prompt.js";
import { expect, test } from "vitest";
import { createAgentMessageDelivery, parseAgentMessages } from "./index.js";
import type { AgentPromptInput } from "../agent-sdk-types.js";

function createClock() {
  let now = 0;
  const jobs = new Map<() => void, number>();
  return {
    schedule(delayMs: number, callback: () => void) {
      jobs.set(callback, now + delayMs);
      return () => {
        jobs.delete(callback);
      };
    },
    advance(ms: number) {
      now += ms;
      for (const [callback, deadline] of jobs) {
        if (deadline > now) continue;
        jobs.delete(callback);
        callback();
      }
    },
  };
}

test("a queued child report and completion reach the recipient in one prompt after two quiet seconds", async () => {
  const clock = createClock();
  const sent: Array<{ recipientId: string; prompt: AgentPromptInput }> = [];
  const delivery = createAgentMessageDelivery({
    schedule: clock.schedule,
    dispatch: async (batch) => {
      sent.push(batch);
      return "steered";
    },
    onError: (error) => {
      throw error;
    },
  });
  const receipt = delivery.enqueue({
    recipientId: "parent",
    messageId: "report",
    prompt: "Results <ready>",
    source: { kind: "agent-message", agentId: "worker" },
  });
  expect(receipt).toMatchObject({ status: "queued", messageId: "report" });
  expect(sent).toEqual([]);
  clock.advance(1000);
  delivery.enqueue({
    recipientId: "parent",
    messageId: "finish",
    prompt: "Worker finished",
    source: { kind: "agent-notification", agentId: "worker", event: "finished" },
  });
  clock.advance(1999);
  expect(sent).toEqual([]);
  clock.advance(1);
  await delivery.close();
  expect(
    sent.map((batch) => ({
      recipientId: batch.recipientId,
      messages: parseAgentMessages(String(batch.prompt)),
    })),
  ).toEqual([
    {
      recipientId: "parent",
      messages: [
        {
          id: "report",
          source: { kind: "agent-message", agentId: "worker" },
          text: "Results <ready>",
        },
        {
          id: "finish",
          source: { kind: "agent-notification", agentId: "worker", event: "finished" },
          text: "Worker finished",
        },
      ],
    },
  ]);
});

test("recipient timers are independent, later messages form another batch, and close flushes pending work", async () => {
  const clock = createClock();
  const sent: string[] = [];
  const delivery = createAgentMessageDelivery({
    schedule: clock.schedule,
    dispatch: async (request) => {
      sent.push(`${request.recipientId}:${request.messageIds.join(",")}`);
      return "steered";
    },
    onError: (error) => {
      throw error;
    },
  });
  const source = { kind: "agent-message" as const, agentId: "worker" };
  const a = delivery.enqueue({ recipientId: "a", messageId: "first", source, prompt: "one" });
  clock.advance(1000);
  const b = delivery.enqueue({ recipientId: "b", messageId: "independent", source, prompt: "two" });
  clock.advance(1000);
  await a.dispatched;
  expect(sent).toEqual(["a:first"]);
  delivery.enqueue({ recipientId: "a", messageId: "later", source, prompt: "three" });
  clock.advance(1000);
  await b.dispatched;
  expect(sent).toEqual(["a:first", "b:independent"]);
  await delivery.close();
  expect(sent).toEqual(["a:first", "b:independent", "a:later"]);
  expect(() => delivery.enqueue({ recipientId: "a", source, prompt: "closed" })).toThrow("closed");
});

test("explicit interrupt and conflicting session modes retain ordered dispatch boundaries", async () => {
  const sent: Array<{
    activeTurnBehavior: string;
    sessionMode?: string;
    messageIds: readonly string[];
  }> = [];
  const delivery = createAgentMessageDelivery({
    dispatch: async (request) => {
      sent.push(request);
      return "steered";
    },
    onError: (error) => {
      throw error;
    },
  });
  const source = { kind: "agent-message" as const, agentId: "worker" };
  delivery.enqueue({
    recipientId: "parent",
    source,
    prompt: "interrupt",
    messageId: "interrupt",
    activeTurnBehavior: "interrupt",
  });
  delivery.enqueue({
    recipientId: "parent",
    source,
    prompt: "review",
    messageId: "review",
    sessionMode: "plan",
  });
  delivery.enqueue({
    recipientId: "parent",
    source,
    prompt: "execute",
    messageId: "execute",
    sessionMode: "full-access",
  });
  delivery.enqueue({
    recipientId: "parent",
    source: { kind: "agent-notification", agentId: "worker", event: "finished" },
    prompt: "done",
    messageId: "finished",
  });
  await delivery.close();
  expect(
    sent.map(({ activeTurnBehavior, sessionMode, messageIds }) => ({
      activeTurnBehavior,
      sessionMode,
      messageIds,
    })),
  ).toEqual([
    { activeTurnBehavior: "interrupt", sessionMode: undefined, messageIds: ["interrupt"] },
    { activeTurnBehavior: "steer", sessionMode: "plan", messageIds: ["review"] },
    {
      activeTurnBehavior: "steer",
      sessionMode: "full-access",
      messageIds: ["execute", "finished"],
    },
  ]);
});

test("dispatch failures reject waits before and after flush and do not poison later messages", async () => {
  const clock = createClock();
  const failed = new Error("provider rejected");
  const errors: unknown[] = [];
  const delivery = createAgentMessageDelivery({
    schedule: clock.schedule,
    dispatch: async (request) => {
      if (request.messageIds.includes("bad")) throw failed;
      return "steered";
    },
    onError: (error) => {
      errors.push(error);
    },
  });
  const message = {
    recipientId: "parent",
    source: { kind: "agent-message" as const, agentId: "worker" },
    prompt: "report",
  };
  const bad = delivery.enqueue({ ...message, messageId: "bad" });
  const before = expect(
    delivery.waitForDispatch("parent", new AbortController().signal),
  ).rejects.toBe(failed);
  clock.advance(2000);
  const after = expect(
    delivery.waitForDispatch("parent", new AbortController().signal),
  ).rejects.toBe(failed);
  await Promise.all([before, after, expect(bad.dispatched).rejects.toBe(failed)]);
  const next = delivery.enqueue({ ...message, messageId: "next" });
  await delivery.close();
  await expect(next.dispatched).resolves.toBe("steered");
  expect(errors).toEqual([failed]);
});

test("canceling a completion wait leaves queued delivery intact", async () => {
  const clock = createClock();
  const delivery = createAgentMessageDelivery({
    schedule: clock.schedule,
    dispatch: async () => "steered",
    onError: (error) => {
      throw error;
    },
  });
  const receipt = delivery.enqueue({
    recipientId: "parent",
    source: { kind: "agent-message", agentId: "worker" },
    prompt: "report",
  });
  const controller = new AbortController();
  const wait = delivery.waitForDispatch("parent", controller.signal);
  controller.abort();
  await expect(wait).rejects.toMatchObject({ name: "AbortError" });
  await delivery.close();
  await expect(receipt.dispatched).resolves.toBe("steered");
});

test("batches retain each sender's attachment context and image order", async () => {
  let prompt: AgentPromptInput = "";
  const delivery = createAgentMessageDelivery({
    dispatch: async (request) => {
      prompt = request.prompt;
      return "steered";
    },
    onError: (error) => {
      throw error;
    },
  });
  const firstImage = { type: "image" as const, data: "Zmlyc3Q=", mimeType: "image/png" };
  const secondImage = { type: "image" as const, data: "c2Vjb25k", mimeType: "image/png" };
  delivery.enqueue({
    recipientId: "parent",
    messageId: "first",
    source: { kind: "agent-message", agentId: "one" },
    prompt: [{ type: "text", text: "First" }, firstImage],
  });
  delivery.enqueue({
    recipientId: "parent",
    messageId: "second",
    source: { kind: "agent-message", agentId: "two" },
    prompt: [
      { type: "text", text: "Second" },
      {
        type: "github_issue",
        mimeType: "application/github-issue",
        number: 42,
        title: "Context",
        url: "https://example.com/42",
        body: "Attached",
      },
      secondImage,
    ],
  });
  await delivery.close();
  expect(prompt).toEqual([
    {
      type: "text",
      text: '<paseo-system version="1" kind="agent-message" source-agent-id="one" message-id="first">\nFirst\n</paseo-system>',
    },
    firstImage,
    {
      type: "text",
      text: '<paseo-system version="1" kind="agent-message" source-agent-id="two" message-id="second">\nSecond\n\nGitHub Issue #42: Context\nhttps://example.com/42\n\nAttached\n</paseo-system>',
    },
    secondImage,
  ]);
  expect(
    parseAgentMessages(
      (prompt as Exclude<AgentPromptInput, string>)
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("\n"),
    )?.map((message) => message.source?.agentId),
  ).toEqual(["one", "two"]);
});

test("runtime safety sees queued messages until provider dispatch settles", async () => {
  const clock = createClock();
  let release!: () => void;
  const dispatched = new Promise<void>((resolve) => {
    release = resolve;
  });
  const delivery = createAgentMessageDelivery({
    schedule: clock.schedule,
    dispatch: async () => {
      await dispatched;
      return "steered";
    },
    onError: (error) => {
      throw error;
    },
  });
  expect(delivery.hasPending("parent")).toBe(false);
  delivery.enqueue({
    recipientId: "parent",
    prompt: "finished",
    source: { kind: "agent-message", agentId: "child" },
  });
  expect(delivery.hasPending("parent")).toBe(true);
  clock.advance(2000);
  expect(delivery.hasPending("parent")).toBe(true);
  release();
  await delivery.close();
  expect(delivery.hasPending("parent")).toBe(false);
});

test("messages wait across quiet windows and batch after the recipient turn ends", async () => {
  const clock = createClock();
  let running = true;
  const sent: Array<readonly string[]> = [];
  const delivery = createAgentMessageDelivery({
    schedule: clock.schedule,
    isRunning: () => running,
    dispatch: async (request) => {
      sent.push(request.messageIds);
      return "turn_started";
    },
    onError: (error) => {
      throw error;
    },
  });
  const source = { kind: "agent-message" as const, agentId: "child" };
  const report = delivery.enqueue({
    recipientId: "parent",
    messageId: "report",
    source,
    prompt: "report",
  });
  clock.advance(2000);
  await Promise.resolve();
  expect(sent).toEqual([]);
  clock.advance(13000);
  const finish = delivery.enqueue({
    recipientId: "parent",
    messageId: "finish",
    source: { kind: "agent-notification", agentId: "child", event: "finished" },
    prompt: "finished",
    activeTurnBehavior: "queue",
  });
  clock.advance(2000);
  await Promise.resolve();
  expect(sent).toEqual([]);
  running = false;
  clock.advance(2000);
  await Promise.all([report.dispatched, finish.dispatched]);
  expect(sent).toEqual([["report", "finish"]]);
  await delivery.close();
});

test("a turn starting during dispatch preparation keeps receipts queued and joins later arrivals", async () => {
  const clock = createClock();
  let busy = true;
  const sent: Array<readonly string[]> = [];
  const delivery = createAgentMessageDelivery({
    schedule: clock.schedule,
    dispatch: async (request) => {
      if (busy) throw new AgentTurnBusyError("concurrent turn");
      sent.push(request.messageIds);
      return "turn_started";
    },
    onError: (error) => {
      throw error;
    },
  });
  const message = {
    recipientId: "parent",
    source: { kind: "agent-message" as const, agentId: "child" },
    prompt: "report",
  };
  const first = delivery.enqueue({ ...message, messageId: "first" });
  clock.advance(2000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(delivery.hasPending("parent")).toBe(true);
  const second = delivery.enqueue({ ...message, messageId: "second" });
  busy = false;
  clock.advance(2000);
  await Promise.all([first.dispatched, second.dispatched]);
  expect(sent).toEqual([["first", "second"]]);
  await delivery.close();
});

test("an interrupt takes the messages queued before it along in one replacing dispatch", async () => {
  const clock = createClock();
  const sent: Array<{ ids: readonly string[]; behavior: string; idleOnly: boolean }> = [];
  const delivery = createAgentMessageDelivery({
    schedule: clock.schedule,
    isRunning: () => true,
    dispatch: async (request) => {
      sent.push({
        ids: request.messageIds,
        behavior: request.activeTurnBehavior,
        idleOnly: request.idleOnly,
      });
      return "turn_started";
    },
    onError: (error) => {
      throw error;
    },
  });
  const message = {
    recipientId: "parent",
    source: { kind: "agent-message" as const, agentId: "child" },
    prompt: "report",
  };
  delivery.enqueue({ ...message, messageId: "wait" });
  const interrupt = delivery.enqueue({
    ...message,
    messageId: "interrupt",
    activeTurnBehavior: "interrupt",
  });
  // No quiet window: the interrupt releases at admission.
  await interrupt.dispatched;
  expect(sent).toEqual([{ ids: ["wait", "interrupt"], behavior: "interrupt", idleOnly: false }]);
  expect(delivery.hasPending("parent")).toBe(false);
  await delivery.close();
  expect(sent).toHaveLength(1);
});

test("shutdown flushes a dispatch that discovered a concurrent turn during preparation", async () => {
  const clock = createClock();
  let release!: () => void;
  const preparing = new Promise<void>((resolve) => {
    release = resolve;
  });
  const modes: boolean[] = [];
  const delivery = createAgentMessageDelivery({
    schedule: clock.schedule,
    dispatch: async (request) => {
      modes.push(request.idleOnly);
      if (request.idleOnly) {
        await preparing;
        throw new AgentTurnBusyError("busy");
      }
      return "turn_started";
    },
    onError: () => {},
  });
  const receipt = delivery.enqueue({
    recipientId: "parent",
    prompt: "report",
    source: { kind: "agent-message", agentId: "child" },
  });
  clock.advance(2000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const closing = delivery.close();
  release();
  await closing;
  await expect(receipt.dispatched).resolves.toBe("turn_started");
  expect(modes).toEqual([true, false]);
});

test("conflicting modes dispatch on separate turn ends without changing the active turn mode", async () => {
  const clock = createClock();
  let busy = false;
  let mode = "initial";
  let wake!: (recipientId: string) => void;
  const sent: Array<{ ids: readonly string[]; mode?: string }> = [];
  const delivery = createAgentMessageDelivery({
    schedule: clock.schedule,
    isRunning: () => busy,
    subscribe: (listener) => {
      wake = listener;
      return () => {};
    },
    dispatch: async (request) => {
      // Mode preparation precedes run admission in the real dispatcher.
      mode = request.sessionMode ?? mode;
      if (busy) throw new AgentTurnBusyError("concurrent turn");
      sent.push({ ids: request.messageIds, mode });
      busy = true;
      return "turn_started";
    },
    onError: (error) => {
      throw error;
    },
  });
  const message = {
    recipientId: "parent",
    source: { kind: "agent-message" as const, agentId: "child" },
    prompt: "message",
  };
  const a = delivery.enqueue({ ...message, messageId: "A", sessionMode: "plan" });
  const b = delivery.enqueue({ ...message, messageId: "B", sessionMode: "default" });
  clock.advance(2000);
  await a.dispatched;
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(mode).toBe("plan");
  expect(sent).toEqual([{ ids: ["A"], mode: "plan" }]);
  busy = false;
  wake("parent");
  await b.dispatched;
  expect(mode).toBe("default");
  expect(sent).toEqual([
    { ids: ["A"], mode: "plan" },
    { ids: ["B"], mode: "default" },
  ]);
  await delivery.close();
});

test("each interrupt releases at admission and keeps its own mode choice", async () => {
  const clock = createClock();
  const sent: Array<{ ids: readonly string[]; mode?: string }> = [];
  const delivery = createAgentMessageDelivery({
    schedule: clock.schedule,
    isRunning: () => true,
    dispatch: async (request) => {
      sent.push({ ids: request.messageIds, mode: request.sessionMode });
      return "turn_started";
    },
    onError: (error) => {
      throw error;
    },
  });
  const message = {
    recipientId: "parent",
    source: { kind: "agent-message" as const, agentId: "child" },
    prompt: "message",
    activeTurnBehavior: "interrupt" as const,
  };
  await delivery.enqueue({ ...message, messageId: "A", sessionMode: "plan" }).dispatched;
  await delivery.enqueue({ ...message, messageId: "B", sessionMode: "default" }).dispatched;

  // Sent back to back, the second still goes after the first, as its own prompt.
  const c = delivery.enqueue({ ...message, messageId: "C", sessionMode: "plan" });
  const d = delivery.enqueue({ ...message, messageId: "D", sessionMode: "default" });
  await Promise.all([c.dispatched, d.dispatched]);

  expect(sent).toEqual([
    { ids: ["A"], mode: "plan" },
    { ids: ["B"], mode: "default" },
    { ids: ["C"], mode: "plan" },
    { ids: ["D"], mode: "default" },
  ]);
  await delivery.close();
});

test("a settled-turn event releases a ready batch without waiting for the next timer sample", async () => {
  const clock = createClock();
  let running = true;
  let settled: (id: string) => void = () => {};
  let subscribed = true;
  const sent: string[] = [];
  const delivery = createAgentMessageDelivery({
    schedule: clock.schedule,
    isRunning: () => running,
    subscribe: (listener) => {
      settled = listener;
      return () => {
        subscribed = false;
      };
    },
    dispatch: async (request) => {
      sent.push(request.recipientId);
      return "turn_started";
    },
    onError: (error) => {
      throw error;
    },
  });
  delivery.enqueue({
    recipientId: "parent",
    prompt: "report",
    source: { kind: "agent-message", agentId: "child" },
  });
  clock.advance(2000);
  expect(sent).toEqual([]);
  running = false;
  settled("parent");
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(sent).toEqual(["parent"]);
  running = true;
  await delivery.close();
  expect(subscribed).toBe(false);
});

test.each([false, true])(
  "completion waits report permission checkpoints without draining messages (initial: %s)",
  async (initial) => {
    const clock = createClock();
    let permission = initial;
    let changed: (id: string) => void = () => {};
    let reported = false;
    let sent = 0;
    const delivery = createAgentMessageDelivery({
      schedule: clock.schedule,
      isRunning: () => true,
      hasPendingPermission: () => permission,
      subscribe: (listener) => {
        changed = listener;
        return () => {};
      },
      dispatch: async () => {
        sent++;
        return "turn_started";
      },
      onError: (error) => {
        throw error;
      },
    });
    delivery.enqueue({
      recipientId: "child",
      prompt: "follow up",
      source: { kind: "agent-message", agentId: "parent" },
    });
    const wait = delivery.waitForDispatch("child", new AbortController().signal).then(() => {
      reported = true;
      return undefined;
    });
    permission = true;
    changed("child");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(reported).toBe(true);
    expect(sent).toBe(0);
    expect(delivery.hasPending("child")).toBe(true);
    await wait;
    await delivery.close();
  },
);

test("a busy admission retry stays ready for the next settled-turn event", async () => {
  const clock = createClock();
  let running = false;
  let raced = true;
  let notify: (id: string) => void = () => {};
  const sent: string[] = [];
  const delivery = createAgentMessageDelivery({
    schedule: clock.schedule,
    isRunning: () => running,
    subscribe: (listener) => {
      notify = listener;
      return () => {};
    },
    dispatch: async (request) => {
      if (raced) {
        running = true;
        throw new AgentTurnBusyError("next turn started");
      }
      sent.push(request.recipientId);
      return "turn_started";
    },
    onError: (error) => {
      throw error;
    },
  });
  delivery.enqueue({
    recipientId: "parent",
    prompt: "report",
    source: { kind: "agent-message", agentId: "child" },
  });
  clock.advance(2000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  raced = false;
  running = false;
  notify("parent");
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(sent).toEqual(["parent"]);
  await delivery.close();
});

test("out-of-band acceptance owns callbacks and receipts; a failed attempt does not block waiting messages", async () => {
  const clock = createClock();
  let running = true;
  let wake!: (recipientId: string) => void;
  const callbacks: string[] = [];
  const sent: string[] = [];
  const errors: unknown[] = [];
  const failure = new Error("recipient could not load");
  const delivery = createAgentMessageDelivery({
    schedule: clock.schedule,
    isRunning: () => running,
    subscribe: (listener) => {
      wake = listener;
      return () => {};
    },
    tryRunOutOfBand: async (request, onAccepted) => {
      const text = parseAgentMessages(String(request.prompt))[0]!.text;
      if (text === "failure") throw failure;
      if (text !== "/handled") return false;
      onAccepted();
      callbacks.push("command ran");
      return true;
    },
    dispatch: async (request) => {
      sent.push(...parseAgentMessages(String(request.prompt)).map((message) => message.text));
      return "turn_started";
    },
    onError: (error) => {
      errors.push(error);
    },
  });
  const message = {
    recipientId: "parent",
    source: { kind: "agent-message" as const, agentId: "child" },
  };
  const ordinary = delivery.enqueue({
    ...message,
    prompt: "ordinary",
    beforeDispatch: () => {
      callbacks.push("ordinary");
    },
  });
  const failed = delivery.enqueue({
    ...message,
    prompt: "failure",
    beforeDispatch: () => {
      callbacks.push("failure");
    },
  });
  const command = delivery.enqueue({
    ...message,
    prompt: "/handled",
    beforeDispatch: () => {
      callbacks.push("command accepted");
    },
    onDispatch: (disposition) => {
      callbacks.push(disposition);
    },
  });
  clock.advance(2000);
  await expect(failed.dispatched).rejects.toBe(failure);
  await expect(command.dispatched).resolves.toBe("out_of_band");
  expect(errors).toEqual([failure]);
  expect(callbacks).toEqual(["command accepted", "command ran", "out_of_band"]);
  expect(sent).toEqual([]);
  running = false;
  wake("parent");
  await ordinary.dispatched;
  expect(callbacks.at(-1)).toBe("ordinary");
  expect(sent).toEqual(["ordinary"]);
  await delivery.close();
});

test("shutdown waits for an in-flight out-of-band attempt and drains its unhandled message", async () => {
  const clock = createClock();
  let release!: () => void;
  let attempted!: () => void;
  const started = new Promise<void>((resolve) => {
    attempted = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const dispatched: boolean[] = [];
  const delivery = createAgentMessageDelivery({
    schedule: clock.schedule,
    isRunning: () => true,
    tryRunOutOfBand: async () => {
      attempted();
      await gate;
      return false;
    },
    dispatch: async (request) => {
      dispatched.push(request.idleOnly);
      return "turn_started";
    },
    onError: (error) => {
      throw error;
    },
  });
  const receipt = delivery.enqueue({
    recipientId: "parent",
    prompt: "ordinary",
    source: { kind: "agent-message", agentId: "child" },
  });
  clock.advance(2000);
  await started;
  const closing = delivery.close();
  release();
  await closing;
  await expect(receipt.dispatched).resolves.toBe("turn_started");
  expect(dispatched).toEqual([false]);
});

test("a declined out-of-band message is offered once across running-turn retries", async () => {
  const clock = createClock();
  let running = true;
  let accepts = false;
  let offers = 0;
  let dispatched = 0;
  let wake!: (recipientId: string) => void;
  const delivery = createAgentMessageDelivery({
    schedule: clock.schedule,
    isRunning: () => running,
    subscribe: (listener) => {
      wake = listener;
      return () => {};
    },
    tryRunOutOfBand: async (_request, onAccepted) => {
      offers++;
      if (accepts) onAccepted();
      return accepts;
    },
    dispatch: async () => {
      dispatched++;
      return "turn_started";
    },
    onError: (error) => {
      throw error;
    },
  });
  const receipt = delivery.enqueue({
    recipientId: "parent",
    prompt: "message",
    source: { kind: "agent-message", agentId: "child" },
  });
  clock.advance(2000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(offers).toBe(1);
  // A later provider state change does not reinterpret a declined message.
  accepts = true;
  for (let retry = 0; retry < 3; retry++) {
    clock.advance(2000);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  expect(offers).toBe(1);
  expect(dispatched).toBe(0);
  running = false;
  wake("parent");
  await receipt.dispatched;
  expect(dispatched).toBe(1);
  await delivery.close();
});

test("a command with an explicit mode waits for turn end without an out-of-band offer", async () => {
  const clock = createClock();
  let running = true;
  let offers = 0;
  let wake!: (recipientId: string) => void;
  const dispatched: Array<{ prompt: AgentPromptInput; sessionMode?: string }> = [];
  const delivery = createAgentMessageDelivery({
    schedule: clock.schedule,
    isRunning: () => running,
    subscribe: (listener) => {
      wake = listener;
      return () => {};
    },
    tryRunOutOfBand: async (_request, onAccepted) => {
      offers++;
      onAccepted();
      return true;
    },
    dispatch: async (request) => {
      dispatched.push(request);
      return "out_of_band";
    },
    onError: (error) => {
      throw error;
    },
  });
  const receipt = delivery.enqueue({
    recipientId: "parent",
    prompt: "/handled",
    sessionMode: "plan",
    source: { kind: "agent-message", agentId: "child" },
  });
  clock.advance(2000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(offers).toBe(0);
  expect(dispatched).toEqual([]);
  running = false;
  wake("parent");
  await receipt.dispatched;
  expect(dispatched).toHaveLength(1);
  expect(dispatched[0]!.sessionMode).toBe("plan");
  expect(parseAgentMessages(String(dispatched[0]!.prompt))![0]!.text).toBe("/handled");
  await delivery.close();
});

test.each([false, true])(
  "withdraws during dispatch preparation and retries the peer when busy is %s",
  async (rejectBusy) => {
    const clock = createClock();
    const preparing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const starts: string[][] = [];
    let attempts = 0;
    const delivery = createAgentMessageDelivery({
      schedule: clock.schedule,
      async dispatch(batch) {
        if (++attempts === 1) {
          preparing.resolve();
          await release.promise;
          if (rejectBusy) throw new AgentTurnBusyError("parent already has a turn");
        }
        if (!batch.admit()) {
          throw new Error("batch was withdrawn");
        }
        starts.push(parseAgentMessages(String(batch.prompt))!.map(({ text }) => text));
        return "turn_started";
      },
      onError(error) {
        throw error;
      },
    });
    const peer = delivery.enqueue({
      recipientId: "parent",
      prompt: "Child report",
      source: { kind: "agent-message", agentId: "child" },
    });
    const update = delivery.enqueue({
      recipientId: "parent",
      prompt: "PR digest",
      source: { kind: "change-request-update", url: "https://github.com/owner/repo/pull/1" },
      unarchive: false,
    });
    try {
      clock.advance(2_000);
      await preparing.promise;
      expect(
        delivery.withdrawPending("parent", ({ kind }) => kind === "change-request-update"),
      ).toBe(1);
      release.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
      clock.advance(2_000);
      await expect(peer.dispatched).resolves.toBe("turn_started");
      await expect(update.dispatched).rejects.toMatchObject({ name: "AbortError" });
      expect(starts).toEqual([["Child report"]]);
    } finally {
      release.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await delivery.close();
    }
  },
);

test("a declined child command offer cannot bring back a withdrawn digest", async () => {
  const clock = createClock();
  const offer = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const starts: string[][] = [];
  let busy = true;
  const delivery = createAgentMessageDelivery({
    schedule: clock.schedule,
    isRunning: () => busy,
    async tryRunOutOfBand(batch) {
      if (String(batch.prompt).includes("Child report")) {
        offer.resolve();
        await release.promise;
      }
      return false;
    },
    async dispatch(batch) {
      if (!batch.admit()) throw new Error("batch was withdrawn");
      starts.push(parseAgentMessages(String(batch.prompt))!.map(({ text }) => text));
      return "turn_started";
    },
    onError(error) {
      throw error;
    },
  });
  const update = delivery.enqueue({
    recipientId: "parent",
    prompt: "PR digest",
    source: { kind: "change-request-update", url: "https://github.com/owner/repo/pull/1" },
  });
  const peer = delivery.enqueue({
    recipientId: "parent",
    prompt: "Child report",
    source: { kind: "agent-message", agentId: "child" },
  });
  try {
    clock.advance(2_000);
    await offer.promise;
    expect(delivery.withdrawPending("parent", ({ kind }) => kind === "change-request-update")).toBe(
      1,
    );
    release.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    busy = false;
    clock.advance(2_000);
    await expect(peer.dispatched).resolves.toBe("turn_started");
    await expect(update.dispatched).rejects.toMatchObject({ name: "AbortError" });
    expect(starts).toEqual([["Child report"]]);
  } finally {
    release.resolve();
    await delivery.close();
  }
});

interface Dispatched {
  ids: readonly string[];
  behavior: string;
  idleOnly: boolean;
  mode?: string;
}

/** One recipient with a running turn, observed the way the daemon wires the queue. */
function createRecipient(
  options: {
    running?: boolean;
    canSteer?: boolean;
    outOfBand?: (prompt: AgentPromptInput) => boolean;
  } = {},
) {
  const clock = createClock();
  const sent: Dispatched[] = [];
  /** Message ids in the order the provider received them, whoever sent the prompt. */
  const received: string[] = [];
  const settleListeners = new Set<(recipientId: string) => void>();
  const stopListeners = new Set<(recipientId: string) => void>();
  let running = options.running ?? true;
  const answered = Promise.resolve();
  let providerAnswer: Promise<void> = answered;
  let managerReady: Promise<void> = answered;
  const outOfBand = options.outOfBand;
  const delivery = createAgentMessageDelivery({
    schedule: clock.schedule,
    isRunning: () => running,
    canSteer: () => options.canSteer ?? true,
    subscribe: (listener) => {
      settleListeners.add(listener);
      return () => settleListeners.delete(listener);
    },
    onStop: (listener) => {
      stopListeners.add(listener);
      return () => stopListeners.delete(listener);
    },
    tryRunOutOfBand: outOfBand
      ? async (request, onAccepted) => {
          const [message] = parseAgentMessages(String(request.prompt)) ?? [];
          if (!message || !outOfBand(message.text)) return false;
          onAccepted();
          return true;
        }
      : undefined,
    dispatch: async (request) => {
      // The manager admits the prompt, the provider gets it, and the provider answers.
      await managerReady;
      if (!request.admit()) throw new Error("The prompt was not admitted");
      received.push(...request.messageIds);
      sent.push({
        ids: request.messageIds,
        behavior: request.activeTurnBehavior,
        idleOnly: request.idleOnly,
        mode: request.sessionMode,
      });
      // An accepted dispatch leaves the recipient with a running turn.
      running = true;
      await providerAnswer;
      return "turn_started";
    },
    onError: (error) => {
      throw error;
    },
  });
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  let next = 0;
  return {
    clock,
    sent,
    received,
    delivery,
    settle,
    ids: () => sent.flatMap((dispatch) => dispatch.ids),
    send(
      activeTurnBehavior: "queue" | "steer" | "interrupt",
      messageId = `m${next++}`,
      agentId = "sender",
    ) {
      return delivery.enqueue({
        recipientId: "recipient",
        source: { kind: "agent-message", agentId },
        messageId,
        prompt: messageId,
        activeTurnBehavior,
      }).messageId;
    },
    /** The manager waits, as it does for a turn that is still starting, before it admits a prompt. */
    holdAdmission() {
      let ready!: () => void;
      managerReady = new Promise<void>((resolve) => {
        ready = resolve;
      });
      return {
        async release() {
          ready();
          managerReady = answered;
          await settle();
        },
      };
    },
    /** The provider takes its time to answer the dispatches that follow. */
    holdProviderAnswer() {
      let accept!: () => void;
      let refuse!: (error: Error) => void;
      providerAnswer = new Promise<void>((resolve, reject) => {
        accept = resolve;
        refuse = reject;
      });
      void providerAnswer.catch(() => undefined);
      return {
        async accept() {
          accept();
          providerAnswer = answered;
          await settle();
        },
        /** The turn never started, so the recipient is idle again. */
        async refuse(error: Error) {
          running = false;
          refuse(error);
          providerAnswer = answered;
          await settle();
        },
      };
    },
    /** A person's prompt: the provider turn it starts is running afterwards. */
    async person(
      prompt: string,
      messageId: string,
      outcome: { fail?: Error; started?: Promise<void> } = {},
    ) {
      const prompts: AgentPromptInput[] = [];
      const result = await delivery
        .sendDirect({ recipientId: "recipient", prompt, messageId }, async (joined) => {
          prompts.push(joined.prompt);
          if (outcome.fail) throw outcome.fail;
          const joinedIds =
            typeof joined.prompt === "string"
              ? parseAgentMessages(joined.prompt)?.map((message) => message.id)
              : undefined;
          received.push(...(joinedIds ?? [messageId]));
          running = true;
          return {
            disposition: "turn_started" as const,
            started: outcome.started ?? Promise.resolve(),
          };
        })
        .catch((error: unknown) => error);
      const [sentPrompt] = prompts;
      return {
        prompt: sentPrompt,
        result,
        ids:
          typeof sentPrompt === "string"
            ? (parseAgentMessages(sentPrompt)?.map((message) => message.id) ?? null)
            : null,
      };
    },
    async endTurn() {
      running = false;
      for (const listener of settleListeners) listener("recipient");
      await settle();
    },
    /** Stop / cancel_agent: the manager announces the stop, then the turn settles. */
    async stop() {
      for (const listener of stopListeners) listener("recipient");
      running = false;
      for (const listener of settleListeners) listener("recipient");
      await settle();
    },
    async tick(ms = 2000) {
      clock.advance(ms);
      await settle();
    },
  };
}

test.each(["sender", "another-sender"])(
  "a queued message that waited ten minutes is delivered ahead of a later interrupt from %s, never after it",
  async (interrupter) => {
    const recipient = createRecipient();
    recipient.send("queue", "go-ahead", "sender");
    for (let elapsed = 0; elapsed < 600_000; elapsed += 2000) await recipient.tick();
    expect(recipient.sent).toEqual([]);

    recipient.send("interrupt", "pause", interrupter);
    await recipient.settle();
    expect(recipient.sent).toEqual([
      { ids: ["go-ahead", "pause"], behavior: "interrupt", idleOnly: false, mode: undefined },
    ]);

    await recipient.endTurn();
    await recipient.tick();
    expect(recipient.sent).toHaveLength(1);
    expect(recipient.delivery.hasPending("recipient")).toBe(false);
    await recipient.delivery.close();
  },
);

test("a queued message admitted after an interrupt waits for the replacement turn to end", async () => {
  const recipient = createRecipient();
  recipient.send("queue", "A");
  recipient.send("interrupt", "B");
  recipient.send("queue", "C");
  await recipient.tick();
  expect(recipient.sent.map((dispatch) => dispatch.ids)).toEqual([["A", "B"]]);

  await recipient.endTurn();
  expect(recipient.sent.map((dispatch) => dispatch.ids)).toEqual([["A", "B"], ["C"]]);
  expect(recipient.sent[1]).toMatchObject({ behavior: "steer", idleOnly: true });
  await recipient.delivery.close();
});

test("a steer enters the running turn at admission and carries the messages queued before it", async () => {
  const recipient = createRecipient();
  recipient.send("queue", "report");
  recipient.send("steer", "course-correction");
  await recipient.settle();
  expect(recipient.sent).toEqual([
    {
      ids: ["report", "course-correction"],
      behavior: "steer",
      idleOnly: false,
      mode: undefined,
    },
  ]);

  await recipient.endTurn();
  await recipient.tick();
  expect(recipient.sent).toHaveLength(1);
  await recipient.delivery.close();
});

test("a steer that misses the turn's end goes again with the messages it carries", async () => {
  const clock = createClock();
  let running = true;
  const sent: Array<{ ids: readonly string[]; behavior: string }> = [];
  const delivery = createAgentMessageDelivery({
    schedule: clock.schedule,
    isRunning: () => running,
    dispatch: async (request) => {
      if (running) {
        // The turn ended before the provider took the steer.
        running = false;
        throw new AgentTurnChangedError("Active turn changed before steering could be delivered");
      }
      sent.push({ ids: request.messageIds, behavior: request.activeTurnBehavior });
      return "turn_started";
    },
    onError: (error) => {
      throw error;
    },
  });
  const message = {
    recipientId: "recipient",
    source: { kind: "agent-message" as const, agentId: "sender" },
    prompt: "message",
  };
  const report = delivery.enqueue({ ...message, messageId: "report", activeTurnBehavior: "queue" });
  const steer = delivery.enqueue({ ...message, messageId: "steer", activeTurnBehavior: "steer" });
  await expect(Promise.all([report.dispatched, steer.dispatched])).resolves.toEqual([
    "turn_started",
    "turn_started",
  ]);
  expect(sent).toEqual([{ ids: ["report", "steer"], behavior: "steer" }]);
  await delivery.close();
});

test("a queued message sent after a steer waits for the turn to end", async () => {
  const recipient = createRecipient();
  recipient.send("steer", "now");
  recipient.send("queue", "later");
  await recipient.tick();
  expect(recipient.sent.map((dispatch) => dispatch.ids)).toEqual([["now"]]);

  await recipient.endTurn();
  expect(recipient.sent.map((dispatch) => dispatch.ids)).toEqual([["now"], ["later"]]);
  expect(recipient.sent[1]).toMatchObject({ idleOnly: true });
  await recipient.delivery.close();
});

test("a message without a behavior is queued", async () => {
  const recipient = createRecipient();
  const receipt = recipient.delivery.enqueue({
    recipientId: "recipient",
    source: { kind: "agent-message", agentId: "sender" },
    prompt: "report",
  });
  expect(receipt.activeTurnBehavior).toBe("queue");
  await recipient.tick();
  expect(recipient.sent).toEqual([]);
  await recipient.delivery.close();
});

test.each([
  {
    behavior: "queue",
    running: false,
    canSteer: true,
    guidance: "Queued. The agent is idle, so your message starts a turn in about 2 seconds.",
  },
  {
    behavior: "queue",
    running: true,
    canSteer: true,
    guidance:
      'Queued, not delivered yet. The agent is working and reads your message when its current turn ends. If the message cannot wait, send a short follow-up with activeTurnBehavior "steer" (it joins the running turn) or "interrupt" (it stops the turn and starts a new one). The follow-up carries this message ahead of it, so do not send this message again.',
  },
  {
    behavior: "queue",
    running: true,
    canSteer: false,
    guidance:
      'Queued, not delivered yet. The agent is working and reads your message when its current turn ends. If the message cannot wait, send a short follow-up with activeTurnBehavior "interrupt" (it stops the turn and starts a new one). This agent\'s provider cannot steer, so "steer" also stops the turn. The follow-up carries this message ahead of it, so do not send this message again.',
  },
  {
    behavior: "steer",
    running: true,
    canSteer: true,
    guidance:
      "Steering the running turn. The agent reads your message at its next step and keeps working.",
  },
  {
    behavior: "steer",
    running: true,
    canSteer: false,
    guidance:
      "This agent's provider cannot steer, so your message interrupts the running turn. A new turn starts with your message.",
  },
  {
    behavior: "interrupt",
    running: true,
    canSteer: true,
    guidance: "Interrupting the running turn. A new turn starts with your message.",
  },
  {
    behavior: "steer",
    running: false,
    canSteer: true,
    guidance: "The agent is idle, so your message starts a turn now.",
  },
  {
    behavior: "interrupt",
    running: false,
    canSteer: false,
    guidance: "The agent is idle, so your message starts a turn now.",
  },
] as const)(
  "the receipt for $behavior (running: $running, can steer: $canSteer) tells the sender what happens",
  async ({ behavior, running, canSteer, guidance }) => {
    const recipient = createRecipient({ running, canSteer });
    const receipt = recipient.delivery.enqueue({
      recipientId: "recipient",
      source: { kind: "agent-message", agentId: "sender" },
      prompt: "report",
      activeTurnBehavior: behavior,
    });
    expect({ behavior: receipt.activeTurnBehavior, guidance: receipt.guidance }).toEqual({
      behavior,
      guidance,
    });
    await recipient.delivery.close();
  },
);

test("an interrupt is dispatched at admission while other messages keep arriving", async () => {
  const recipient = createRecipient();
  recipient.send("interrupt", "pause");
  await recipient.settle();
  expect(recipient.ids()).toEqual(["pause"]);
  // Reports that keep the quiet window open cannot hold a later interrupt back either.
  for (let i = 0; i < 5; i++) {
    recipient.send("queue", `report-${i}`);
    await recipient.tick(1900);
  }
  recipient.send("interrupt", "pause-again");
  await recipient.settle();
  expect(recipient.sent.at(-1)).toMatchObject({
    ids: ["report-0", "report-1", "report-2", "report-3", "report-4", "pause-again"],
    behavior: "interrupt",
  });
  await recipient.delivery.close();
});

test("steady arrivals cannot keep an idle recipient's quiet window open past ten seconds", async () => {
  const recipient = createRecipient({ running: false });
  for (let i = 0; i < 6; i++) {
    recipient.send("queue", `report-${i}`);
    await recipient.tick(1900);
  }
  // 11.4 seconds of arrivals under two seconds apart: the window closed at ten.
  expect(recipient.sent.map((dispatch) => dispatch.ids)).toEqual([
    ["report-0", "report-1", "report-2", "report-3", "report-4", "report-5"],
  ]);
  await recipient.delivery.close();
});

test("the provider receives every prompt in admission order for every short interleaving", async () => {
  const actions = ["queue", "steer", "interrupt", "person", "stop", "end-turn", "tick"] as const;
  const length = 5;
  for (let scenario = 0; scenario < actions.length ** length; scenario++) {
    const recipient = createRecipient();
    const admitted: string[] = [];
    const script: string[] = [];
    let rest = scenario;
    for (let step = 0; step < length; step++) {
      const action = actions[rest % actions.length]!;
      rest = Math.floor(rest / actions.length);
      script.push(action);
      if (action === "end-turn") await recipient.endTurn();
      else if (action === "tick") await recipient.tick();
      else if (action === "stop") await recipient.stop();
      else if (action === "person") {
        admitted.push(`person-${step}`);
        await recipient.person(`person-${step}`, `person-${step}`);
      } else admitted.push(recipient.send(action));
      await recipient.settle();
    }
    // Let every remaining message out: windows close, turns end, and a last prompt takes
    // whatever a Stop still holds.
    for (let i = 0; i < 4; i++) {
      await recipient.tick();
      await recipient.endTurn();
    }
    await recipient.person("last", "last");
    expect(recipient.received, script.join(" → ")).toEqual([...admitted, "last"]);
    expect(recipient.delivery.hasPending("recipient"), script.join(" → ")).toBe(false);
    await recipient.delivery.close();
  }
});

test("order and Stop hold for every short interleaving while the provider is slow to answer", async () => {
  const actions = ["queue", "interrupt", "person", "stop", "tick", "hold", "answer"] as const;
  const length = 5;
  for (let scenario = 0; scenario < actions.length ** length; scenario++) {
    // The provider is offered waiting messages as commands, so closed windows line up queue
    // steps behind a dispatch the provider has not answered yet.
    const recipient = createRecipient({ outOfBand: () => false });
    const admitted: string[] = [];
    const admittedAt = new Map<string, number>();
    const script: string[] = [];
    let provider: ReturnType<typeof recipient.holdProviderAnswer> | undefined;
    let stoppedWhileHeld = false;
    let lastStop = -1;
    let checked = 0;
    const answer = async () => {
      // A turn that Stop canceled while it was starting never starts.
      if (stoppedWhileHeld) await provider?.refuse(new Error("run was canceled"));
      else await provider?.accept();
      provider = undefined;
      stoppedWhileHeld = false;
    };
    /** After a Stop, no queue dispatch carries only messages from before it. */
    const checkStop = () => {
      for (const dispatch of recipient.sent.slice(checked)) {
        const newest = Math.max(...dispatch.ids.map((id) => admittedAt.get(id) ?? -1));
        expect(newest, `${script.join(" → ")}: ${dispatch.ids.join(",")}`).toBeGreaterThan(
          lastStop,
        );
      }
      checked = recipient.sent.length;
    };
    let rest = scenario;
    for (let step = 0; step < length; step++) {
      const action = actions[rest % actions.length]!;
      rest = Math.floor(rest / actions.length);
      script.push(action);
      if (action === "tick") await recipient.tick();
      else if (action === "hold") provider ??= recipient.holdProviderAnswer();
      else if (action === "answer") await answer();
      else if (action === "stop") {
        lastStop = step;
        stoppedWhileHeld = provider !== undefined;
        await recipient.stop();
      } else if (action === "person") {
        admitted.push(`person-${step}`);
        admittedAt.set(`person-${step}`, step);
        void recipient.person(`person-${step}`, `person-${step}`);
      } else {
        const id = recipient.send(action);
        admitted.push(id);
        admittedAt.set(id, step);
      }
      await recipient.settle();
      checkStop();
    }
    await answer();
    checkStop();
    // Let every remaining message out: windows close, turns end, and a last prompt takes
    // whatever a Stop still holds.
    for (let i = 0; i < 4; i++) {
      await recipient.tick();
      await recipient.endTurn();
    }
    await recipient.person("last", "last");
    // A turn the provider refused is sent again, so each prompt counts where it last arrived.
    const arrived = recipient.received.filter(
      (id, index) => recipient.received.lastIndexOf(id) === index,
    );
    expect(arrived, script.join(" → ")).toEqual([...admitted, "last"]);
    expect(recipient.delivery.hasPending("recipient"), script.join(" → ")).toBe(false);
    await recipient.delivery.close();
  }
});

test("a person's prompt carries the queued messages ahead of it in the same prompt", async () => {
  const recipient = createRecipient();
  recipient.send("queue", "go-ahead");
  await recipient.tick();

  const { prompt, result } = await recipient.person("pause it", "person-1");
  expect(result).toMatchObject({ disposition: "turn_started" });
  expect(typeof prompt === "string" ? parseAgentMessages(prompt) : null).toEqual([
    { id: "go-ahead", source: { kind: "agent-message", agentId: "sender" }, text: "go-ahead" },
    { id: "person-1", source: null, text: "pause it" },
  ]);
  expect(recipient.delivery.hasPending("recipient")).toBe(false);

  // Nothing is left to start a turn of its own when the person's turn ends.
  await recipient.endTurn();
  await recipient.tick();
  expect(recipient.sent).toEqual([]);
  await recipient.delivery.close();
});

test("a person's prompt is untouched when nothing is queued, and a command travels alone", async () => {
  const recipient = createRecipient();
  expect((await recipient.person("hello", "person-1")).prompt).toBe("hello");

  recipient.send("queue", "report");
  await recipient.tick();
  // Providers parse commands from raw text, so the queue stays where it is.
  expect((await recipient.person("/compact", "person-2")).prompt).toBe("/compact");
  expect(recipient.delivery.hasPending("recipient")).toBe(true);
  await recipient.endTurn();
  expect(recipient.ids()).toEqual(["report"]);
  await recipient.delivery.close();
});

test("queued messages survive a person's prompt that fails to send", async () => {
  const recipient = createRecipient();
  recipient.send("queue", "report");
  await recipient.tick();
  const failure = new Error("provider refused the prompt");
  expect((await recipient.person("hello", "person-1", { fail: failure })).result).toBe(failure);
  expect(recipient.delivery.hasPending("recipient")).toBe(true);
  await recipient.endTurn();
  expect(recipient.ids()).toEqual(["report"]);
  await recipient.delivery.close();
});

test("Stop holds the messages queued before it until the recipient's next prompt", async () => {
  const recipient = createRecipient();
  recipient.send("queue", "go-ahead");
  await recipient.tick();

  await recipient.stop();
  await recipient.tick();
  await recipient.tick(60_000);
  // The stopped recipient stays stopped: no queued message starts a turn.
  expect(recipient.sent).toEqual([]);
  // Held messages need a prompt, so neither completion waits nor runtime guards wait for them.
  expect(recipient.delivery.hasPending("recipient")).toBe(false);
  await recipient.delivery.waitForDispatch("recipient", new AbortController().signal);

  // A message admitted after the Stop is a new prompt: the held one goes ahead of it.
  recipient.send("queue", "later");
  await recipient.tick();
  expect(recipient.sent).toEqual([
    { ids: ["go-ahead", "later"], behavior: "steer", idleOnly: true, mode: undefined },
  ]);
  await recipient.delivery.close();
});

test("a person's prompt after Stop carries the held messages", async () => {
  const recipient = createRecipient();
  recipient.send("queue", "go-ahead");
  await recipient.stop();

  const { prompt } = await recipient.person("continue", "person-1");
  expect(
    typeof prompt === "string" ? parseAgentMessages(prompt)?.map((message) => message.id) : null,
  ).toEqual(["go-ahead", "person-1"]);
  await recipient.endTurn();
  expect(recipient.sent).toEqual([]);
  await recipient.delivery.close();
});

test("a turn that ends on its own still releases the queue", async () => {
  const recipient = createRecipient();
  recipient.send("queue", "report");
  await recipient.tick();
  await recipient.endTurn();
  expect(recipient.ids()).toEqual(["report"]);
  await recipient.delivery.close();
});

test("a prompt's place in line is decided when it is sent, not when the provider gets to it", async () => {
  const recipient = createRecipient();
  const provider = recipient.holdProviderAnswer();
  recipient.send("interrupt", "first");
  await recipient.settle();

  // All three arrive while the provider has not answered the first dispatch yet.
  recipient.send("queue", "older");
  const person = recipient.person("stop and wait", "person-1");
  recipient.send("queue", "newer");
  await provider.accept();

  expect((await person).ids).toEqual(["older", "person-1"]);
  await recipient.tick();
  await recipient.endTurn();
  expect(recipient.sent.map((dispatch) => dispatch.ids)).toEqual([["first"], ["newer"]]);
  await recipient.delivery.close();
});

test("an interrupt sent after a person's prompt does not take older messages past that prompt", async () => {
  const recipient = createRecipient();
  const provider = recipient.holdProviderAnswer();
  recipient.send("interrupt", "first");
  await recipient.settle();

  recipient.send("queue", "older");
  const person = recipient.person("stop and wait", "person-1");
  recipient.send("interrupt", "newer");
  await provider.accept();

  expect((await person).ids).toEqual(["older", "person-1"]);
  await recipient.settle();
  expect(recipient.sent.map((dispatch) => dispatch.ids)).toEqual([["first"], ["newer"]]);
  expect(recipient.sent[1]).toMatchObject({ behavior: "interrupt", idleOnly: false });
  await recipient.delivery.close();
});

test("a queue step already in line does not pick up an interrupt sent after a person's prompt", async () => {
  // The provider is offered waiting messages as commands, so a closed window lines up a
  // queue step behind the dispatch in flight.
  const recipient = createRecipient({ outOfBand: () => false });
  const provider = recipient.holdProviderAnswer();
  recipient.send("interrupt", "first");
  await recipient.settle();
  recipient.send("queue", "older");
  await recipient.tick();

  const person = recipient.person("stop and wait", "person-1");
  recipient.send("interrupt", "newer");
  recipient.send("queue", "newest");
  await provider.accept();

  expect((await person).ids).toEqual(["older", "person-1"]);
  await recipient.settle();
  expect(recipient.received).toEqual(["first", "older", "person-1", "newer"]);
  await recipient.tick();
  await recipient.endTurn();
  expect(recipient.received).toEqual(["first", "older", "person-1", "newer", "newest"]);
  await recipient.delivery.close();
});

test("Stop holds an interrupt that was still waiting for the provider", async () => {
  const recipient = createRecipient();
  const provider = recipient.holdProviderAnswer();
  const first = recipient.send("interrupt", "first");
  await recipient.settle();
  recipient.send("interrupt", "second");
  await recipient.settle();
  expect(recipient.ids()).toEqual([first]);

  // Stop cancels the turn that was starting. The interrupt behind it must not start another.
  await recipient.stop();
  await provider.refuse(new Error("run was canceled before its turn started"));
  await recipient.tick();
  await recipient.tick(60_000);
  expect(recipient.ids()).toEqual(["first"]);
  expect(recipient.delivery.hasPending("recipient")).toBe(false);

  // Neither message is lost: both go with the recipient's next prompt, in order.
  expect((await recipient.person("continue", "person-1")).ids).toEqual([
    "first",
    "second",
    "person-1",
  ]);
  await recipient.delivery.close();
});

test("a held interrupt waits like any other message once a later message releases it", async () => {
  const recipient = createRecipient();
  const provider = recipient.holdProviderAnswer();
  recipient.send("interrupt", "first");
  await recipient.settle();
  recipient.send("interrupt", "second");
  await recipient.stop();
  await provider.refuse(new Error("run was canceled before its turn started"));

  recipient.send("queue", "later");
  await recipient.settle();
  expect(recipient.ids()).toEqual(["first"]);
  await recipient.tick();
  expect(recipient.sent.at(-1)).toEqual({
    ids: ["first", "second", "later"],
    behavior: "steer",
    idleOnly: true,
    mode: undefined,
  });
  await recipient.delivery.close();
});

test("queued messages return to the queue when the provider rejects the person's turn", async () => {
  const recipient = createRecipient();
  const report = recipient.delivery.enqueue({
    recipientId: "recipient",
    source: { kind: "agent-message", agentId: "sender" },
    messageId: "report",
    prompt: "report",
  });
  await recipient.tick();

  let rejectStart!: (error: Error) => void;
  const started = new Promise<void>((_resolve, reject) => {
    rejectStart = reject;
  });
  void started.catch(() => undefined);
  const person = await recipient.person("hello", "person-1", { started });
  expect(person.result).toMatchObject({ disposition: "turn_started" });
  expect(person.ids).toEqual(["report", "person-1"]);

  // An interrupt sent while the provider decides must not overtake the older report.
  recipient.send("interrupt", "pause");
  await recipient.settle();
  expect(recipient.sent).toEqual([]);

  rejectStart(new Error("provider rejected the turn"));
  await recipient.settle();
  expect(recipient.sent.map((dispatch) => dispatch.ids)).toEqual([["report", "pause"]]);
  await expect(report.dispatched).resolves.toBe("turn_started");
  await recipient.delivery.close();
});

test("a person's prompt that begins with a path is plain text and carries the queue", async () => {
  const recipient = createRecipient();
  recipient.send("queue", "go-ahead");
  await recipient.tick();

  const path = await recipient.person(
    "/tmp/build.log is stale. Wait for my next prompt.",
    "person-1",
  );
  expect(path.ids).toEqual(["go-ahead", "person-1"]);

  recipient.send("queue", "report");
  await recipient.tick();
  for (const command of ["/compact", "  /goal pause", "/review focus on tests"]) {
    expect((await recipient.person(command, "person-2")).prompt).toBe(command);
  }
  expect(recipient.delivery.hasPending("recipient")).toBe(true);
  await recipient.delivery.close();
});

test("an interrupt the provider runs as a command beside the turn takes no queued message along", async () => {
  const recipient = createRecipient({ outOfBand: (prompt) => prompt === "/compact" });
  recipient.send("queue", "report");
  await recipient.tick();

  const compact = recipient.delivery.enqueue({
    recipientId: "recipient",
    source: { kind: "agent-message", agentId: "sender" },
    messageId: "compact",
    prompt: "/compact",
    activeTurnBehavior: "interrupt",
  });
  await expect(compact.dispatched).resolves.toBe("out_of_band");
  // The command replaced nothing, so the report still waits for the turn to end.
  expect(recipient.sent).toEqual([]);
  await recipient.endTurn();
  expect(recipient.ids()).toEqual(["report"]);

  // An interrupt the provider declines to run beside the turn replaces it, queue first.
  recipient.send("queue", "another-report");
  const plain = recipient.delivery.enqueue({
    recipientId: "recipient",
    source: { kind: "agent-message", agentId: "sender" },
    messageId: "pause",
    prompt: "pause",
    activeTurnBehavior: "interrupt",
  });
  await expect(plain.dispatched).resolves.toBe("turn_started");
  expect(recipient.sent.at(-1)).toMatchObject({
    ids: ["another-report", "pause"],
    behavior: "interrupt",
  });
  await recipient.delivery.close();
});

test("an interrupt keeps its place ahead of a later person's prompt when a queue step is already in line", async () => {
  // The provider is offered waiting messages as commands, so a closed window lines up a
  // queue step behind the dispatch in flight.
  const recipient = createRecipient({ outOfBand: () => false });
  const provider = recipient.holdProviderAnswer();
  recipient.send("interrupt", "first");
  await recipient.settle();
  recipient.send("queue", "older");
  await recipient.tick();

  recipient.send("interrupt", "pause");
  const person = recipient.person("carry on", "person-1");
  await provider.accept();

  // The interrupt replaces the turn itself; the person's prompt follows it and carries nothing.
  expect((await person).prompt).toBe("carry on");
  expect(recipient.sent.at(-1)).toEqual({
    ids: ["older", "pause"],
    behavior: "interrupt",
    idleOnly: false,
    mode: undefined,
  });
  expect(recipient.received).toEqual(["first", "older", "pause", "person-1"]);
  await recipient.delivery.close();
});

test("an interrupt that was waiting when Stop arrived stays held when a later message reopens the queue", async () => {
  const recipient = createRecipient();
  const manager = recipient.holdAdmission();
  recipient.send("interrupt", "pause");
  await recipient.settle();

  // The later steer arrives before the manager gets back to the interrupt.
  await recipient.stop();
  recipient.send("queue", "later");
  await manager.release();
  expect(recipient.sent).toEqual([]);

  // The held interrupt goes with the later message, as a steer.
  await recipient.tick();
  expect(recipient.sent).toEqual([
    { ids: ["pause", "later"], behavior: "steer", idleOnly: true, mode: undefined },
  ]);
  await recipient.delivery.close();
});

test("messages whose starting turn Stop canceled are kept when a later message reopens the queue", async () => {
  const recipient = createRecipient({ running: false });
  const provider = recipient.holdProviderAnswer();
  const report = recipient.delivery.enqueue({
    recipientId: "recipient",
    source: { kind: "agent-message", agentId: "sender" },
    messageId: "report",
    prompt: "report",
  });
  await recipient.tick();
  expect(recipient.ids()).toEqual(["report"]);

  await recipient.stop();
  recipient.send("queue", "later");
  await provider.refuse(new Error("run was canceled before its turn started"));

  await recipient.tick();
  expect(recipient.sent.at(-1)).toMatchObject({ ids: ["report", "later"] });
  await expect(report.dispatched).resolves.toBe("turn_started");
  await recipient.delivery.close();
});

test("shutdown delivers the messages a rejected person's turn returns to the queue", async () => {
  const recipient = createRecipient();
  const report = recipient.delivery.enqueue({
    recipientId: "recipient",
    source: { kind: "agent-message", agentId: "sender" },
    messageId: "report",
    prompt: "report",
  });
  await recipient.tick();
  let rejectStart!: (error: Error) => void;
  const started = new Promise<void>((_resolve, reject) => {
    rejectStart = reject;
  });
  void started.catch(() => undefined);
  await recipient.person("hello", "person-1", { started });

  // Shutdown begins while the provider is still deciding, then the provider rejects the turn.
  let closed = false;
  const closing = recipient.delivery.close().then(() => {
    closed = true;
    return undefined;
  });
  rejectStart(new Error("provider rejected the turn"));
  await recipient.settle();
  await recipient.settle();

  expect(closed).toBe(true);
  expect(recipient.sent.map((dispatch) => dispatch.ids)).toEqual([["report"]]);
  await expect(report.dispatched).resolves.toBe("turn_started");
  await closing;
});

test("a queue step reserved before Stop releases nothing once the queue reopens", async () => {
  // The provider is offered waiting messages as commands, so a closed window lines up a
  // queue step behind the dispatch in flight.
  const recipient = createRecipient({ outOfBand: () => false });
  const provider = recipient.holdProviderAnswer();
  recipient.send("interrupt", "first");
  await recipient.settle();
  recipient.send("queue", "older");
  await recipient.tick();

  // The new interrupt arrives before the provider has finished stopping.
  await recipient.stop();
  recipient.send("interrupt", "newer");
  await provider.refuse(new Error("run was canceled before its turn started"));
  await recipient.settle();

  // One turn after the Stop: the held messages, then the interrupt that follows them.
  expect(recipient.sent.slice(1)).toEqual([
    { ids: ["first", "older", "newer"], behavior: "interrupt", idleOnly: false, mode: undefined },
  ]);
  await recipient.delivery.close();
});

test("held messages stay held when the message that reopened the queue is withdrawn", async () => {
  const recipient = createRecipient();
  recipient.send("queue", "older");
  await recipient.stop();

  // A later message reopens the queue, then its sender takes it back before the window closes.
  recipient.send("queue", "update", "watcher");
  expect(
    recipient.delivery.withdrawPending(
      "recipient",
      (source) => source.kind === "agent-message" && source.agentId === "watcher",
    ),
  ).toBe(1);
  await recipient.tick();
  await recipient.tick(60_000);
  expect(recipient.sent).toEqual([]);
  expect(recipient.delivery.hasPending("recipient")).toBe(false);

  expect((await recipient.person("continue", "person-1")).ids).toEqual(["older", "person-1"]);
  await recipient.delivery.close();
});
