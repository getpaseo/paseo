import { useCallback } from "react";
import { useComposer } from "@getpaseo/plugin/client";
import { Action, Select, Toggle } from "@getpaseo/plugin/client/ui";

type ContextLength = "short" | "long";

const CONTEXT_OPTIONS = [
  { value: "short", label: "Short", description: "Answer from the files you name." },
  { value: "long", label: "Long", description: "Read the surrounding code first." },
] as const;

const CONTEXT_KEY = "composer-controls.contextLength";
const REVIEW_KEY = "composer-controls.needsReview";

/** Reads and writes agent metadata, so the choice is saved with the agent. */
export function ContextLength() {
  const composer = useComposer();
  const current: ContextLength = composer.agent.metadata[CONTEXT_KEY] === "long" ? "long" : "short";
  const change = useCallback(
    ({ value }: { value: ContextLength }) => composer.setMetadata({ [CONTEXT_KEY]: value }),
    [composer],
  );
  return (
    <Select
      title="Context length"
      icon="Gauge"
      value={current}
      options={CONTEXT_OPTIONS}
      onValueChange={change}
    />
  );
}

export function ReviewFlag() {
  const composer = useComposer();
  const change = useCallback(
    ({ value }: { value: boolean }) => composer.setMetadata({ [REVIEW_KEY]: value ? true : null }),
    [composer],
  );
  return (
    <Toggle
      title="Needs review"
      icon="Flag"
      value={composer.agent.metadata[REVIEW_KEY] === true}
      onValueChange={change}
    />
  );
}

/**
 * Changes a provider option. Only Codex reports `plan_mode`, so the control is disabled for
 * other providers. The promise it returns keeps the control pending, and a rejection reaches the
 * user as a toast.
 */
export function PlanFirst() {
  const composer = useComposer();
  const change = useCallback(
    ({ value }: { value: boolean }) => composer.setOptions({ plan_mode: value }),
    [composer],
  );
  return (
    <Toggle
      title="Plan first"
      icon="ListTodo"
      disabled={composer.agent.provider !== "codex"}
      value={composer.agent.options.plan_mode === true}
      onValueChange={change}
    />
  );
}

/** Works the same in the agent, draft and New workspace composers. */
export function Checklist() {
  const composer = useComposer();
  const insert = useCallback(() => composer.insertText("- [ ] Tests\n- [ ] Docs\n"), [composer]);
  return <Action title="Insert checklist" icon="ListChecks" onPress={insert} />;
}
