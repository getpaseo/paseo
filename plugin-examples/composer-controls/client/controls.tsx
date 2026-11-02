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
  const value: ContextLength = composer.agent.metadata[CONTEXT_KEY] === "long" ? "long" : "short";
  const change = useCallback(
    (next: ContextLength) => composer.setMetadata({ [CONTEXT_KEY]: next }),
    [composer],
  );
  return (
    <Select
      title="Context length"
      icon="Gauge"
      value={value}
      options={CONTEXT_OPTIONS}
      onValueChange={change}
    />
  );
}

export function ReviewFlag() {
  const composer = useComposer();
  const change = useCallback(
    (next: boolean) => composer.setMetadata({ [REVIEW_KEY]: next ? true : null }),
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

/** Works the same in the agent, draft and New workspace composers. */
export function Checklist() {
  const composer = useComposer();
  const insert = useCallback(() => composer.insertText("- [ ] Tests\n- [ ] Docs\n"), [composer]);
  return <Action title="Insert checklist" icon="ListChecks" onPress={insert} />;
}
