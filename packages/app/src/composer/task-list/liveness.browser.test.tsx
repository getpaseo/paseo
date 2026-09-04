import type { AgentStreamEventPayload } from "@getpaseo/protocol/messages";
import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionStore } from "@/stores/session-store";
import {
  type AgentStreamReducerQueue,
  createSessionAgentStreamReducerQueue,
  deriveAgentStreamTurnLiveness,
} from "@/timeline/session-stream-reducers";
import type { TodoEntry, UserMessageItem } from "@/types/stream";
import { AgentTaskList } from "./index";

// App sources compile against the classic JSX runtime, which expects React on the global.
beforeEach(() => vi.stubGlobal("React", React));

const SERVER_ID = "task-list-liveness";
const AGENT_ID = "agent";
const RUNNING_TASK: TodoEntry = {
  id: "t1",
  text: "Run checks",
  activeForm: "Running checks",
  completed: false,
  status: "in_progress",
};
const TASKS: TodoEntry[] = [RUNNING_TASK];

const TODO: AgentStreamEventPayload = {
  type: "timeline",
  provider: "codex",
  item: { type: "todo", items: TASKS },
};
const turnStarted = (turnId: string): AgentStreamEventPayload => ({
  type: "turn_started",
  provider: "codex",
  turnId,
});
const turnCompleted = (turnId: string): AgentStreamEventPayload => ({
  type: "turn_completed",
  provider: "codex",
  turnId,
});

interface Mounted {
  root: Root;
  container: HTMLDivElement;
}

const mounted: Mounted[] = [];

function mount(node: ReactNode): void {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  mounted.push({ root, container });
}

/**
 * The composer keeps the last task snapshot after the turn that wrote it ends, so a run that
 * stops mid-task leaves an in-progress row on screen. That row must go still when the turn does,
 * and must stay still when the next turn starts. Events go through the real reducer queue and the
 * real session store, on the same two paths the session context uses: turn liveness applied at
 * once, timeline items on the queue's deferred flush.
 */
describe("composer task rows follow the turn, not the row's own status", () => {
  let queue: AgentStreamReducerQueue;
  let seq = 0;

  beforeEach(() => {
    seq = 0;
    useSessionStore.getState().initializeSession(SERVER_ID, null as never);
    queue = createSessionAgentStreamReducerQueue({
      serverId: SERVER_ID,
      setAgentStreamState: (...args) => useSessionStore.getState().setAgentStreamState(...args),
      setAgentTimelineCursor: (...args) =>
        useSessionStore.getState().setAgentTimelineCursor(...args),
      recoverTimelineGap: () => {},
    });
  });

  afterEach(() => {
    queue.dispose();
    for (const entry of mounted.splice(0)) {
      act(() => entry.root.unmount());
      entry.container.remove();
    }
    useSessionStore.getState().clearSession(SERVER_ID);
  });

  /** Mirrors `session-context.tsx`: liveness first, then the queue; the flush comes later. */
  function receive(events: AgentStreamEventPayload[]): void {
    act(() => {
      for (const event of events) {
        seq += 1;
        const reducerEvent = { event, seq, epoch: "epoch-1", timestamp: new Date(1000 + seq) };
        const liveness = deriveAgentStreamTurnLiveness([reducerEvent]);
        if (liveness.length > 0) {
          useSessionStore.getState().applyAgentTurnLiveness(SERVER_ID, AGENT_ID, liveness);
        }
        queue.enqueue(AGENT_ID, reducerEvent);
      }
    });
  }

  function flush(): void {
    act(() => queue.flushAgent(AGENT_ID));
  }

  function submitPrompt(): void {
    const message: UserMessageItem = {
      kind: "user_message",
      id: "m1",
      clientMessageId: "c1",
      text: "next prompt",
      timestamp: new Date(),
    };
    act(() => useSessionStore.getState().beginAgentMessageSubmission(SERVER_ID, AGENT_ID, message));
  }

  function openPanelRow(): Element {
    mount(<AgentTaskList serverId={SERVER_ID} agentId={AGENT_ID} tasks={TASKS} />);
    const trigger = document.querySelector('[data-testid="agent-task-list-header"]');
    if (!(trigger instanceof HTMLElement)) {
      throw new Error("task pill did not render");
    }
    act(() => trigger.click());
    const panelRow = document.querySelector('[aria-label="Running checks"]');
    if (!panelRow) {
      throw new Error("task row did not render in the panel");
    }
    return panelRow;
  }

  function countAnimated(panelRow: Element): number {
    return [...panelRow.querySelectorAll("*")].filter(
      (element) => element.getAnimations().length > 0,
    ).length;
  }

  it("orbits an in-progress row while the turn that wrote it is open", () => {
    receive([turnStarted("turn-1"), TODO]);
    flush();

    expect(countAnimated(openPanelRow())).toBe(1);
  });

  it("holds the same row still once the turn closes", () => {
    receive([turnStarted("turn-1"), TODO]);
    flush();
    receive([turnCompleted("turn-1")]);
    flush();

    expect(countAnimated(openPanelRow())).toBe(0);
  });

  it("leaves the retained snapshot still when the next turn starts", () => {
    receive([turnStarted("turn-1"), TODO]);
    flush();
    receive([turnCompleted("turn-1")]);
    flush();
    receive([turnStarted("turn-2")]);
    flush();

    expect(countAnimated(openPanelRow())).toBe(0);
  });

  it("leaves the retained snapshot still while a submitted prompt waits for its turn", () => {
    receive([turnStarted("turn-1"), TODO]);
    flush();
    receive([turnCompleted("turn-1")]);
    flush();
    submitPrompt();

    expect(countAnimated(openPanelRow())).toBe(0);
  });

  it("leaves the retained snapshot still when the turn ends before the flush records it", () => {
    receive([turnStarted("turn-1")]);
    flush();
    // The last todo, the turn's end and the next turn's start arrive inside one flush window.
    receive([TODO, turnCompleted("turn-1"), turnStarted("turn-2")]);
    flush();

    expect(countAnimated(openPanelRow())).toBe(0);
  });

  it("orbits again once the next turn writes its own snapshot", () => {
    receive([turnStarted("turn-1"), TODO]);
    flush();
    receive([turnCompleted("turn-1"), turnStarted("turn-2")]);
    flush();
    receive([TODO]);
    flush();

    expect(countAnimated(openPanelRow())).toBe(1);
  });
});
