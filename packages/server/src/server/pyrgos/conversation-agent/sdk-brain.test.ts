import { describe, expect, it } from "vitest";
import { ConversationAgent } from "./agent.js";
import { SdkBrain, subscriptionEnv, toBrainEvent } from "./sdk-brain.js";
import type { ConversationEvent } from "./types.js";

type FakeInput = Parameters<
  NonNullable<ConstructorParameters<typeof SdkBrain>[0]["queryFactory"]>
>[0];

const delta = (text: string) => ({
  type: "stream_event",
  event: { type: "content_block_delta", delta: { type: "text_delta", text } },
});

/** A fake SDK: every user message in gets the scripted messages out, then a result. */
function fakeFactory(replies: unknown[][], seen: FakeInput[] = []) {
  let interrupts = 0;
  const factory = ((input: FakeInput) => {
    seen.push(input);
    const source = input.prompt as AsyncIterable<unknown>;
    const queue = [...replies];
    async function* messages() {
      for await (const _ of source) {
        for (const m of queue.shift() ?? []) yield m;
        yield { type: "result" };
      }
    }
    const iterator = messages();
    return Object.assign(iterator, {
      interrupt: async () => {
        interrupts += 1;
      },
    });
  }) as unknown as NonNullable<ConstructorParameters<typeof SdkBrain>[0]["queryFactory"]>;
  return { factory, interrupts: () => interrupts };
}

describe("subscriptionEnv", () => {
  it("drops metered API credentials and keeps the rest", () => {
    const env = subscriptionEnv({ ANTHROPIC_API_KEY: "x", ANTHROPIC_AUTH_TOKEN: "y", HOME: "/h" });
    expect(env).toEqual({ HOME: "/h" });
  });
});

describe("toBrainEvent", () => {
  it("maps text deltas, tool use and tool results; ignores the rest", () => {
    expect(toBrainEvent(delta("hi"))).toEqual({ type: "text", text: "hi" });
    expect(
      toBrainEvent({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "mcp__harness__status" }] },
      }),
    ).toEqual({ type: "tool_use", name: "mcp__harness__status" });
    expect(toBrainEvent({ type: "user", message: { content: [{ type: "tool_result" }] } })).toEqual(
      {
        type: "tool_result",
      },
    );
    expect(toBrainEvent({ type: "system" })).toBeNull();
  });
});

describe("SdkBrain", () => {
  it("runs two turns on one warm session with a locked-down option set", async () => {
    const seen: FakeInput[] = [];
    const { factory } = fakeFactory([[delta("Hello there.")], [delta("Second.")]], seen);
    const brain = new SdkBrain({
      model: "opus",
      tools: [],
      context: "<harness-context>x</harness-context>",
      queryFactory: factory,
    });
    const collect = async (text: string) => {
      const out: string[] = [];
      for await (const e of brain.runTurn(text)) if (e.type === "text") out.push(e.text);
      return out.join("");
    };
    expect(await collect("hi")).toBe("Hello there.");
    expect(await collect("again")).toBe("Second.");
    expect(seen).toHaveLength(1);
    const options = seen[0].options;
    expect(options.model).toBe("opus");
    expect(options.tools).toEqual([]);
    expect(options.settingSources).toEqual([]);
    expect(options.includePartialMessages).toBe(true);
    expect(options.systemPrompt).toContain("<harness-context>");
    expect(options.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    await brain.close();
  });

  it("drives a full text turn through the agent: filler, chunks, end", async () => {
    const { factory } = fakeFactory([
      [
        {
          type: "assistant",
          message: { content: [{ type: "tool_use", name: "mcp__harness__status" }] },
        },
        { type: "user", message: { content: [{ type: "tool_result" }] } },
        delta("Two agents are running. "),
        delta("One is idle."),
      ],
    ]);
    const brain = new SdkBrain({ model: "haiku", tools: [], queryFactory: factory });
    const events: ConversationEvent[] = [];
    const agent = new ConversationAgent({ brain, model: "haiku", onEvent: (e) => events.push(e) });
    await agent.handleTranscript("what is going on with the agents");
    const speak = events
      .filter((e) => e.type === "speak")
      .map((e) => (e.type === "speak" ? e.text : ""));
    expect(speak[0]).toBe("One sec.");
    expect(speak.join(" ")).toContain("Two agents are running.");
    expect(events.at(-1)?.type).toBe("turn_end");
    await agent.close();
  });

  it("interrupt calls the SDK interrupt and the turn still drains to its result", async () => {
    const { factory, interrupts } = fakeFactory([[delta("Long answer, "), delta("more words. ")]]);
    const brain = new SdkBrain({
      model: "haiku",
      tools: [],
      queryFactory: factory,
      drainTimeoutMs: 50,
    });
    const gen = brain.runTurn("talk");
    await gen.next();
    await brain.interrupt();
    for await (const _ of gen) {
      // drained without emitting
    }
    expect(interrupts()).toBe(1);
    await brain.close();
  });
});
