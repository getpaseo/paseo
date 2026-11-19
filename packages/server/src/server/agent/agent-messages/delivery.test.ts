import { AgentTurnBusyError } from "../agent-prompt.js";
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

test("a queued child report and completion reach the recipient in one steer after two quiet seconds", async () => {
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
    activeTurnBehavior: "steer",
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

test("explicit interrupt bypasses a running turn while ordinary messages keep waiting", async () => {
  const clock = createClock();
  const sent: Array<readonly string[]> = [];
  const delivery = createAgentMessageDelivery({
    schedule: clock.schedule,
    isRunning: () => true,
    dispatch: async (request) => {
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
  delivery.enqueue({ ...message, messageId: "wait" });
  const interrupt = delivery.enqueue({
    ...message,
    messageId: "interrupt",
    activeTurnBehavior: "interrupt",
  });
  clock.advance(2000);
  await interrupt.dispatched;
  expect(sent).toEqual([["interrupt"]]);
  expect(delivery.hasPending("parent")).toBe(true);
  await delivery.close();
  expect(sent).toEqual([["interrupt"], ["wait"]]);
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

test("interrupts retain separate mode choices while the recipient is busy", async () => {
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
  const a = delivery.enqueue({ ...message, messageId: "A", sessionMode: "plan" });
  const b = delivery.enqueue({ ...message, messageId: "B", sessionMode: "default" });
  clock.advance(2000);
  await Promise.all([a.dispatched, b.dispatched]);
  expect(sent).toEqual([
    { ids: ["A"], mode: "plan" },
    { ids: ["B"], mode: "default" },
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
