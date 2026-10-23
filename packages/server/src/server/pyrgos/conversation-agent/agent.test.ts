import { describe, expect, it } from "vitest";
import { ConversationAgent, wantsFiller } from "./agent.js";
import type { Brain, BrainEvent, ConversationEvent } from "./types.js";

function scriptedBrain(script: BrainEvent[][]): Brain & { interrupts: number; turns: string[] } {
  const queue = [...script];
  const brain = {
    interrupts: 0,
    turns: [] as string[],
    async *runTurn(text: string) {
      brain.turns.push(text);
      for (const event of queue.shift() ?? []) yield event;
    },
    async interrupt() {
      brain.interrupts += 1;
    },
    async close() {},
  };
  return brain;
}

/** A brain whose turn blocks until released or interrupted. */
function blockingBrain(): Brain & { release: () => void } {
  let release = () => {};
  let ended = false;
  const brain = {
    release: () => release(),
    async *runTurn() {
      yield { type: "text", text: "Starting to answer, " } satisfies BrainEvent;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      if (!ended)
        yield { type: "text", text: "late words that must not be spoken. " } satisfies BrainEvent;
    },
    async interrupt() {
      ended = true;
      release();
    },
    async close() {},
  };
  return brain;
}

function collect() {
  const events: ConversationEvent[] = [];
  return { events, onEvent: (e: ConversationEvent) => events.push(e) };
}

describe("wantsFiller", () => {
  it("fires for tool-looking questions on any model", () => {
    expect(wantsFiller("what is the status", "haiku")).toBe(true);
  });
  it("fires for 4+ word turns on slow models only", () => {
    expect(wantsFiller("tell me a joke please", "opus")).toBe(true);
    expect(wantsFiller("tell me a joke please", "haiku")).toBe(false);
    expect(wantsFiller("hello there", "opus")).toBe(false);
  });
});

describe("ConversationAgent", () => {
  it("chunks a reply into assistant_chunk and speak events, then ends the turn", async () => {
    const { events, onEvent } = collect();
    const brain = scriptedBrain([
      [
        { type: "text", text: "Sure, I can do that. It is " },
        { type: "text", text: "done now." },
      ],
    ]);
    const agent = new ConversationAgent({ brain, model: "haiku", onEvent });
    await agent.handleTranscript("hi");
    const chunks = events.filter((e) => e.type === "assistant_chunk").map((e) => e.text);
    expect(chunks.join(" ")).toBe("Sure, I can do that. It is done now.");
    expect(events.filter((e) => e.type === "speak").every((e) => e.kind === "reply")).toBe(true);
    expect(events.at(-1)).toEqual({ type: "turn_end", turnId: 1 });
  });

  it("speaks the filler at once on a slow tool-looking turn", async () => {
    const { events, onEvent } = collect();
    const brain = scriptedBrain([[{ type: "text", text: "Two tickets are open." }]]);
    const agent = new ConversationAgent({ brain, model: "opus", onEvent });
    await agent.handleTranscript("what is the status of the tickets");
    expect(events[0]).toEqual({ type: "speak", turnId: 1, text: "One sec.", kind: "filler" });
  });

  it("speaks the filler at the first tool_use when the question did not look slow", async () => {
    const { events, onEvent } = collect();
    const brain = scriptedBrain([
      [
        { type: "tool_use", name: "mcp__harness__status" },
        { type: "tool_use", name: "mcp__harness__search" },
        { type: "tool_result" },
        { type: "text", text: "All quiet." },
      ],
    ]);
    const agent = new ConversationAgent({ brain, model: "haiku", onEvent });
    await agent.handleTranscript("hello");
    const fillers = events.filter((e) => e.type === "speak" && e.kind === "filler");
    expect(fillers).toHaveLength(1);
  });

  it("does not speak the filler once reply text has started", async () => {
    const { events, onEvent } = collect();
    const brain = scriptedBrain([
      [
        { type: "text", text: "Well, let me look. " },
        { type: "tool_use", name: "x" },
      ],
    ]);
    const agent = new ConversationAgent({ brain, model: "haiku", onEvent });
    await agent.handleTranscript("hello");
    expect(events.some((e) => e.type === "speak" && e.kind === "filler")).toBe(false);
  });

  it("honours filler: null", async () => {
    const { events, onEvent } = collect();
    const brain = scriptedBrain([[{ type: "text", text: "Done." }]]);
    const agent = new ConversationAgent({ brain, model: "opus", onEvent, filler: null });
    await agent.handleTranscript("what is the status of the tickets");
    expect(events.some((e) => e.type === "speak" && e.kind === "filler")).toBe(false);
  });

  it("barge-in interrupts the brain and drops the old turn's late output", async () => {
    const { events, onEvent } = collect();
    const brain = blockingBrain();
    const agent = new ConversationAgent({ brain, model: "haiku", onEvent, filler: null });
    const first = agent.handleTranscript("start talking");
    await new Promise((r) => setTimeout(r, 10));
    expect(agent.busy).toBe(true);
    await agent.bargeIn();
    await first;
    expect(events.some((e) => e.type === "interrupted")).toBe(true);
    expect(events.some((e) => e.type === "turn_end")).toBe(false);
    const spoken = events.filter((e) => e.type === "speak").map((e) => e.text);
    expect(spoken.join(" ")).not.toContain("late words");
    expect(agent.busy).toBe(false);
  });

  it("a new transcript during a turn is a barge-in, then runs", async () => {
    const { events, onEvent } = collect();
    let calls = 0;
    const brain: Brain = {
      async *runTurn() {
        calls += 1;
        if (calls === 1) {
          yield { type: "text", text: "First answer, " };
          await new Promise((r) => setTimeout(r, 30));
          yield { type: "text", text: "never heard. " };
        } else {
          yield { type: "text", text: "Second answer." };
        }
      },
      async interrupt() {},
      async close() {},
    };
    const agent = new ConversationAgent({ brain, model: "haiku", onEvent, filler: null });
    const first = agent.handleTranscript("one");
    await new Promise((r) => setTimeout(r, 5));
    await agent.handleTranscript("two");
    await first;
    const spoken = events
      .filter((e) => e.type === "speak")
      .map((e) => e.text)
      .join(" ");
    expect(spoken).toContain("Second answer.");
    expect(spoken).not.toContain("never heard");
    expect(events.filter((e) => e.type === "turn_end")).toHaveLength(1);
  });

  it("reports a brain failure as an error event", async () => {
    const { events, onEvent } = collect();
    const brain: Brain = {
      // eslint-disable-next-line require-yield
      async *runTurn() {
        throw new Error("boom");
      },
      async interrupt() {},
      async close() {},
    };
    const agent = new ConversationAgent({ brain, model: "haiku", onEvent });
    await agent.handleTranscript("hello");
    expect(events.at(-1)).toEqual({ type: "error", turnId: 1, message: "boom" });
  });

  it("ignores empty transcripts", async () => {
    const { events, onEvent } = collect();
    const brain = scriptedBrain([]);
    const agent = new ConversationAgent({ brain, model: "haiku", onEvent });
    await agent.handleTranscript("   ");
    expect(events).toHaveLength(0);
    expect(brain.turns).toHaveLength(0);
  });
});
