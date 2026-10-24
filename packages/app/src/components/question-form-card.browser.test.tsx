import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { within } from "@testing-library/dom";
import type { AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n as testI18n } from "@/i18n/i18next";
import type { PendingPermission } from "@/types/shared";
import { useSessionStore } from "@/stores/session-store";
import { QuestionFormCard } from "./question-form-card";

// Load translations so controls expose their real accessible names.
void testI18n;

// App sources compile against the classic JSX runtime, which expects React on the global.
beforeEach(() => vi.stubGlobal("React", React));

/**
 * A real browser with the real web `EditingTextInput`, because the bug under test lives in the
 * gap between that input and React state: the input owns its text and never replays state, so a
 * card that drops the Other text from state alone keeps showing it while submit ignores it.
 */

interface Mounted {
  root: Root;
  container: HTMLDivElement;
}

const mounted: Mounted[] = [];

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

function buildPermission(
  question: Record<string, unknown> | Record<string, unknown>[],
): PendingPermission {
  return {
    key: "perm-1",
    agentId: "agent-1",
    request: {
      id: "perm-1",
      provider: "claude",
      name: "AskUserQuestion",
      kind: "question",
      input: { questions: Array.isArray(question) ? question : [question] },
    },
  };
}

function mountCard(question: Record<string, unknown>) {
  const onRespond = vi.fn<(response: AgentPermissionResponse) => void>();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <QuestionFormCard
        serverId="server-1"
        permission={buildPermission(question)}
        onRespond={onRespond}
        isResponding={false}
        responseError={null}
      />,
    ),
  );
  mounted.push({ root, container });

  const view = within(container);
  const optionRole = question.multiSelect ? "checkbox" : "radio";
  const otherInput = () =>
    view.getByRole<HTMLInputElement>("textbox", { name: String(question.question) });
  const check = (label: string) => act(() => view.getByRole(optionRole, { name: label }).click());
  const type = (text: string) => {
    const input = otherInput();
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!valueSetter) throw new Error("HTML input value setter is unavailable");
    act(() => {
      valueSetter.call(input, text);
      input.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
    });
  };
  const pickDraft = (text: string) =>
    act(() => view.getByRole("button", { name: `Use suggestion: ${text}` }).click());
  const submit = () => act(() => view.getByRole("button", { name: "Submit" }).click());
  const submittedAnswers = (): Record<string, string> => {
    const response = onRespond.mock.calls[0]?.[0];
    if (!response || response.behavior !== "allow") throw new Error("card did not submit");
    return (response.updatedInput as { answers: Record<string, string> }).answers;
  };
  return { check, type, pickDraft, otherInput, submit, submittedAnswers };
}

const multiSelectQuestion = {
  question: "Which fruits do you like?",
  header: "Fruits",
  options: [{ label: "Apple" }, { label: "Banana" }, { label: "Cherry" }],
  multiSelect: true,
  allowOther: true,
};

const singleSelectQuestion = {
  question: "Which provider?",
  header: "Provider",
  options: [{ label: "Claude Code" }, { label: "Codex" }],
  multiSelect: false,
  allowOther: true,
};

describe("QuestionFormCard other answers", () => {
  it("keeps checked options when the other answer is typed afterwards (multi-select)", () => {
    const card = mountCard(multiSelectQuestion);

    card.check("Apple");
    card.check("Cherry");
    card.type("durian");
    card.submit();

    expect(card.submittedAnswers()).toEqual({ Fruits: "Apple, Cherry, durian" });
  });

  it("keeps the typed other answer when options are checked afterwards (multi-select)", () => {
    const card = mountCard(multiSelectQuestion);

    card.type("durian");
    card.check("Apple");
    card.check("Banana");

    expect(card.otherInput().value).toBe("durian");
    card.submit();
    expect(card.submittedAnswers()).toEqual({ Fruits: "Apple, Banana, durian" });
  });

  it("replaces the selected option with the typed other answer (single-select)", () => {
    const card = mountCard(singleSelectQuestion);

    card.check("Codex");
    card.type("OpenCode");
    card.submit();

    expect(card.submittedAnswers()).toEqual({ Provider: "OpenCode" });
  });

  it("clears the typed other answer on screen when an option is picked afterwards (single-select)", () => {
    const card = mountCard(singleSelectQuestion);

    card.type("OpenCode");
    card.check("Codex");

    expect(card.otherInput().value).toBe("");
    card.submit();
    expect(card.submittedAnswers()).toEqual({ Provider: "Codex" });
  });
});

function seedDrafts(suggestions: Array<{ id: string; text: string; questionIndex?: number }>) {
  const promptSuggestions = new Map([
    ["agent-1", { turnSeq: 1, suggestions, generatedAt: "", answersPermissionId: "perm-1" }],
  ]);
  useSessionStore.setState({
    sessions: { "server-1": { promptSuggestions } } as unknown as ReturnType<
      typeof useSessionStore.getState
    >["sessions"],
  });
}

function mountQuestions(questions: Record<string, unknown>[]) {
  const onRespond = vi.fn<(response: AgentPermissionResponse) => void>();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <QuestionFormCard
        serverId="server-1"
        permission={buildPermission(questions)}
        onRespond={onRespond}
        isResponding={false}
        responseError={null}
      />,
    ),
  );
  mounted.push({ root, container });
  const view = within(container);
  return {
    drafts: () =>
      view
        .queryAllByRole("button", { name: /^Use suggestion: / })
        .map((chip) => chip.getAttribute("aria-label")?.replace("Use suggestion: ", "")),
    pickDraft: (text: string) =>
      act(() => view.getByRole("button", { name: `Use suggestion: ${text}` }).click()),
    input: () => view.getByRole<HTMLInputElement>("textbox"),
    next: () => act(() => view.getByRole("button", { name: "Next" }).click()),
    submit: () => act(() => view.getByRole("button", { name: "Submit" }).click()),
    submittedAnswers: (): Record<string, string> => {
      const response = onRespond.mock.calls[0]?.[0];
      if (!response || response.behavior !== "allow") throw new Error("card did not submit");
      return (response.updatedInput as { answers: Record<string, string> }).answers;
    },
  };
}

const databaseQuestion = { question: "Which database?", header: "DB", options: [] };
const regionQuestion = { question: "Which region?", header: "Region", options: [] };

describe("QuestionFormCard drafted answers", () => {
  afterEach(() => useSessionStore.setState({ sessions: {} }));

  it("shows each question only the drafts written for it", () => {
    seedDrafts([
      { id: "s1", text: "Postgres", questionIndex: 0 },
      { id: "s2", text: "eu-west-1", questionIndex: 1 },
      { id: "s3", text: "SQLite", questionIndex: 0 },
    ]);
    const card = mountQuestions([databaseQuestion, regionQuestion]);

    expect(card.drafts()).toEqual(["Postgres", "SQLite"]);
    card.pickDraft("Postgres");
    card.next();

    expect(card.drafts()).toEqual(["eu-west-1"]);
    card.pickDraft("eu-west-1");
    card.submit();
    expect(card.submittedAnswers()).toEqual({ DB: "Postgres", Region: "eu-west-1" });
  });

  it("clears the answer box when moving to a question worded the same", () => {
    seedDrafts([
      { id: "s1", text: "alpha", questionIndex: 0 },
      { id: "s2", text: "beta", questionIndex: 1 },
    ]);
    const same = { question: "Which name?", options: [] };
    const card = mountQuestions([
      { ...same, header: "First" },
      { ...same, header: "Second" },
    ]);

    card.pickDraft("alpha");
    card.next();

    expect(card.input().value).toBe("");
    expect(card.drafts()).toEqual(["beta"]);
    card.pickDraft("beta");
    card.submit();
    expect(card.submittedAnswers()).toEqual({ First: "alpha", Second: "beta" });
  });

  it("hides untagged drafts from an older daemon when several questions take text", () => {
    seedDrafts([{ id: "s1", text: "Postgres" }]);
    const card = mountQuestions([databaseQuestion, regionQuestion]);

    expect(card.drafts()).toEqual([]);
    card.next();
    expect(card.drafts()).toEqual([]);
  });

  it("shows a picked draft in the answer box and submits it", () => {
    const suggestions = [{ id: "s1", text: "OpenCode" }];
    const promptSuggestions = new Map([
      ["agent-1", { turnSeq: 1, suggestions, generatedAt: "", answersPermissionId: "perm-1" }],
    ]);
    useSessionStore.setState({
      sessions: { "server-1": { promptSuggestions } } as unknown as ReturnType<
        typeof useSessionStore.getState
      >["sessions"],
    });
    const card = mountCard(singleSelectQuestion);

    card.check("Codex");
    card.pickDraft("OpenCode");

    expect(card.otherInput().value).toBe("OpenCode");
    card.submit();
    expect(card.submittedAnswers()).toEqual({ Provider: "OpenCode" });
  });
});
