import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentTaskList } from "@/composer/task-list";
import { en } from "@/i18n/resources/en";
import type { TodoEntry } from "@/types/stream";
import { TaskListRow } from "./task-list-row";

const translations = createInstance();
const TASKS: TodoEntry[] = [
  {
    text: "Inspect",
    completed: true,
    status: "completed",
    state: "completed",
    phase: "Delivery",
    phaseIndex: 0,
  },
  {
    text: "Implement",
    activeForm: "Implementing",
    completed: false,
    status: "in_progress",
    state: "in_progress",
    phase: "Delivery",
    phaseIndex: 0,
  },
  {
    text: "Review",
    completed: false,
    status: "pending",
    state: "pending",
    phase: "Delivery",
    phaseIndex: 0,
  },
  {
    text: "Review",
    completed: false,
    status: "pending",
    state: "blocked",
    phase: "Delivery",
    phaseIndex: 1,
    blocker: "Waiting for approval from the release owner",
  },
  {
    text: "Old rollout",
    completed: true,
    status: "completed",
    state: "abandoned",
    phase: "Delivery",
    phaseIndex: 1,
  },
];
const LEGACY_RUNNING_TASK: TodoEntry = {
  text: "Run checks",
  activeForm: "Running checks",
  status: "in_progress",
  completed: false,
};

let container: HTMLDivElement;
let root: Root;

beforeAll(async () => {
  await translations.init({
    lng: "en",
    fallbackLng: "en",
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
});

beforeEach(() => {
  // The app's classic JSX runtime expects React on the global.
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function render(node: ReactNode): void {
  act(() => root.render(<I18nextProvider i18n={translations}>{node}</I18nextProvider>));
}

function taskPanel(): HTMLElement {
  const panel = document.querySelector('[data-testid="agent-task-list-header-panel"]');
  if (!(panel instanceof HTMLElement)) throw new Error("Task panel did not open");
  return panel;
}

describe("task presentation", () => {
  it("shows mixed native states, distinct equal-named phases, blocker updates, and clears", () => {
    render(<AgentTaskList tasks={TASKS} />);
    const trigger = container.querySelector('[data-testid="agent-task-list-header"]');
    if (!(trigger instanceof HTMLElement)) throw new Error("Task list trigger did not render");
    expect(trigger.textContent).toBe("2/5 tasks · 1 abandoned");
    act(() => trigger.click());

    const panel = taskPanel();
    expect(
      Array.from(panel.querySelectorAll('[role="heading"]'), (heading) => heading.textContent),
    ).toEqual(["Delivery", "Delivery"]);
    expect(
      Array.from(panel.querySelectorAll('[aria-label^="Delivery."]'), (row) =>
        row.getAttribute("aria-label"),
      ),
    ).toEqual([
      "Delivery. Inspect",
      "Delivery. Implementing",
      "Delivery. Review",
      "Delivery. Review. Blocked. Waiting for approval from the release owner",
      "Delivery. Old rollout. Abandoned",
    ]);
    expect(panel.textContent).toContain("Blocked");
    expect(panel.textContent).toContain("Abandoned");
    expect(panel.textContent).toContain("Waiting for approval from the release owner");

    const blockedIndex = TASKS.findIndex((task) => task.state === "blocked");
    const blockedTask = TASKS[blockedIndex];
    if (!blockedTask) throw new Error("Blocked task fixture is missing");
    const updated = [...TASKS];
    updated[blockedIndex] = { ...blockedTask, blocker: "Waiting for credentials" };
    render(<AgentTaskList tasks={updated} />);
    expect(taskPanel().textContent).toContain("Waiting for credentials");
    expect(taskPanel().textContent).not.toContain("Waiting for approval from the release owner");

    render(<AgentTaskList tasks={[]} />);
    expect(container.querySelector('[data-testid="agent-task-list-header"]')).toBeNull();
    expect(document.querySelector('[data-testid="agent-task-list-header-panel"]')).toBeNull();
  });

  it("keeps the active form visible for legacy running tasks", () => {
    render(<TaskListRow task={LEGACY_RUNNING_TASK} />);
    expect(container.textContent).toBe("Running checks");
  });
});
