import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ComposerTextInput } from "./input/text-input.web";
import type { ComposerTextInputHandle } from "./input/text-input-types";
import { resolveRecall, resolveRecallDirection, type RecallSession } from "./message-recall";

/**
 * Recall runs on the composer's key press path, which is React Native Web mapping a DOM keydown
 * onto `onKeyPress`. These tests drive real key events through a real textarea so the mapping,
 * the walk, and the caret placement are covered together.
 */

interface MountedRecall {
  root: Root;
  container: HTMLDivElement;
  textarea: HTMLTextAreaElement;
}

const mounted: MountedRecall[] = [];

interface RecallKeyPressEvent {
  nativeEvent: { key: string; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean };
  preventDefault: () => void;
}

function noop(): void {}

/** The composer's recall handler, with its one piece of state, outside of React. */
function createRecallHandler(
  history: readonly string[],
  handleRef: React.RefObject<ComposerTextInputHandle | null>,
  textarea: () => HTMLTextAreaElement | null,
): (event: RecallKeyPressEvent) => void {
  let session: RecallSession | null = null;
  return (event) => {
    const direction = resolveRecallDirection(event.nativeEvent);
    if (!direction) return;
    const element = textarea();
    const text = handleRef.current?.getText() ?? "";
    const outcome = resolveRecall({
      history,
      session,
      snapshot: {
        text,
        selection: {
          start: element?.selectionStart ?? text.length,
          end: element?.selectionEnd ?? text.length,
        },
      },
      direction,
    });
    if (!outcome) return;
    session = outcome.session;
    event.preventDefault();
    handleRef.current?.replaceText(outcome.text, outcome.selection);
  };
}

function mountRecall(history: readonly string[]): MountedRecall {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const handleRef = React.createRef<ComposerTextInputHandle>();
  const onKeyPress = createRecallHandler(history, handleRef, () =>
    container.querySelector("textarea"),
  );

  act(() => {
    root.render(
      <ComposerTextInput
        ref={handleRef}
        text=""
        multiline={true}
        onChangeText={noop}
        onKeyPress={onKeyPress}
        testID="composer-input"
      />,
    );
  });

  const textarea = container.querySelector("textarea");
  if (!textarea) {
    throw new Error("Composer text input did not render a textarea");
  }

  const instance = { root, container, textarea };
  mounted.push(instance);
  return instance;
}

function press(textarea: HTMLTextAreaElement, key: string, modifiers?: KeyboardEventInit): boolean {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...modifiers,
  });
  act(() => {
    textarea.dispatchEvent(event);
  });
  return event.defaultPrevented;
}

function type(textarea: HTMLTextAreaElement, text: string, caret = text.length): void {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  if (!valueSetter) {
    throw new Error("HTML textarea value setter is unavailable");
  }
  act(() => {
    valueSetter.call(textarea, text);
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
  });
  textarea.setSelectionRange(caret, caret);
}

afterEach(() => {
  for (const instance of mounted.splice(0)) {
    act(() => instance.root.unmount());
    instance.container.remove();
  }
});

describe("composer message recall", () => {
  const history = ["fix the flaky test", "run the suite"];

  it("fills the empty composer with the last sent message and puts the caret at the end", () => {
    const { textarea } = mountRecall(history);

    expect(press(textarea, "ArrowUp")).toBe(true);

    expect(textarea.value).toBe("fix the flaky test");
    expect(textarea.selectionStart).toBe("fix the flaky test".length);
    expect(textarea.selectionEnd).toBe("fix the flaky test".length);
  });

  it("walks back and forward, ending on the empty composer it started from", () => {
    const { textarea } = mountRecall(history);

    press(textarea, "ArrowUp");
    press(textarea, "ArrowUp");
    expect(textarea.value).toBe("run the suite");

    expect(press(textarea, "ArrowUp")).toBe(false);
    expect(textarea.value).toBe("run the suite");

    press(textarea, "ArrowDown");
    expect(textarea.value).toBe("fix the flaky test");

    press(textarea, "ArrowDown");
    expect(textarea.value).toBe("");
  });

  it("stashes a half typed prompt and gives it back with its caret", () => {
    const { textarea } = mountRecall(history);
    type(textarea, "deploy the", 6);

    expect(press(textarea, "ArrowUp")).toBe(true);
    expect(textarea.value).toBe("fix the flaky test");

    press(textarea, "ArrowDown");
    expect(textarea.value).toBe("deploy the");
    expect(textarea.selectionStart).toBe(6);
  });

  it("moves the caret instead of recalling when a line sits above it", () => {
    const { textarea } = mountRecall(history);
    type(textarea, "first line\nsecond line");

    expect(press(textarea, "ArrowUp")).toBe(false);
    expect(textarea.value).toBe("first line\nsecond line");

    // Caret back on the first line: nothing above it, so recall takes the key and stashes both.
    textarea.setSelectionRange(3, 3);
    expect(press(textarea, "ArrowUp")).toBe(true);
    expect(textarea.value).toBe("fix the flaky test");

    press(textarea, "ArrowDown");
    expect(textarea.value).toBe("first line\nsecond line");
  });

  it("starts a new walk, stashing the edit, once the recalled text is changed", () => {
    const { textarea } = mountRecall(history);

    press(textarea, "ArrowUp");
    type(textarea, "fix the flaky test in CI");

    expect(press(textarea, "ArrowUp")).toBe(true);
    expect(textarea.value).toBe("fix the flaky test");

    press(textarea, "ArrowDown");
    expect(textarea.value).toBe("fix the flaky test in CI");
  });

  it("ignores modified arrows so platform and app shortcuts keep working", () => {
    const { textarea } = mountRecall(history);

    expect(press(textarea, "ArrowUp", { metaKey: true })).toBe(false);
    expect(press(textarea, "ArrowUp", { shiftKey: true })).toBe(false);
    expect(textarea.value).toBe("");
  });

  it("does nothing for an agent with no messages yet", () => {
    const { textarea } = mountRecall([]);

    expect(press(textarea, "ArrowUp")).toBe(false);
    expect(textarea.value).toBe("");
  });
});

/**
 * Restoring an abandoned walk depends on React running every effect cleanup before any effect
 * body in a commit, which is what lets the composer read the draft text it is leaving rather
 * than the one it is switching to. Losing that ordering would silently persist a recalled
 * message over the user's own draft, so it is pinned here.
 */
describe("abandoned walk restore", () => {
  function AbandonProbe({ agentId, draftText, onAbandon }: AbandonProbeProps) {
    const committedDraftRef = React.useRef({ text: draftText, write: onAbandon });
    React.useEffect(() => {
      committedDraftRef.current = { text: draftText, write: onAbandon };
    });
    React.useEffect(() => {
      return () => {
        const committed = committedDraftRef.current;
        committed.write(committed.text);
      };
    }, [agentId]);
    return null;
  }

  it("stays out of the way while the same composer re-renders", () => {
    // The bug this pins: keying the effect on a callback prop tore the walk down mid-recall,
    // because the composer hands down a fresh writer as the draft updates.
    const abandoned: string[] = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <AbandonProbe agentId="agent-a" draftText="typing" onAbandon={appendTo(abandoned)} />,
      );
    });
    act(() => {
      root.render(
        <AbandonProbe agentId="agent-a" draftText="typing more" onAbandon={appendTo(abandoned)} />,
      );
    });

    expect(abandoned).toEqual([]);

    act(() => root.unmount());
    container.remove();
    expect(abandoned).toEqual(["typing more"]);
  });

  it("sees the draft it is leaving, not the one it is switching to", () => {
    const abandoned: string[] = [];
    const onAbandon = appendTo(abandoned);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <AbandonProbe agentId="agent-a" draftText="fix the flaky test" onAbandon={onAbandon} />,
      );
    });
    act(() => {
      root.render(<AbandonProbe agentId="agent-b" draftText="other agent" onAbandon={onAbandon} />);
    });

    expect(abandoned).toEqual(["fix the flaky test"]);

    act(() => root.unmount());
    container.remove();
    expect(abandoned).toEqual(["fix the flaky test", "other agent"]);
  });
});

function appendTo(sink: string[]): (text: string) => void {
  return (text) => {
    sink.push(text);
  };
}

interface AbandonProbeProps {
  agentId: string;
  draftText: string;
  onAbandon: (text: string) => void;
}
