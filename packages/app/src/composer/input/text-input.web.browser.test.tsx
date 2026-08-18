import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ComposerTextInput } from "./text-input.web";
import type { ComposerTextInputHandle } from "./text-input-types";

interface MountedInput {
  root: Root;
  container: HTMLDivElement;
  textarea: HTMLTextAreaElement;
  inputRef: React.MutableRefObject<ComposerTextInputHandle | null>;
}

interface TextRecorder {
  changes: string[];
  onChangeText: (text: string) => void;
}

const mountedInputs: MountedInput[] = [];

function mountInput(
  onChangeText: (text: string) => void,
  inputRef: React.MutableRefObject<ComposerTextInputHandle | null> = React.createRef(),
): MountedInput {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(
      <ComposerTextInput
        ref={inputRef}
        text=""
        multiline={true}
        onChangeText={onChangeText}
        testID="composer-input"
      />,
    );
  });

  const textarea = container.querySelector("textarea");
  if (!textarea) {
    throw new Error("Composer text input did not render a textarea");
  }

  const mounted = { root, container, textarea, inputRef };
  mountedInputs.push(mounted);
  return mounted;
}

function dispatchComposition(
  textarea: HTMLTextAreaElement,
  type: "compositionstart" | "compositionend",
) {
  textarea.dispatchEvent(new CompositionEvent(type, { bubbles: true }));
}

function typeFromIme(textarea: HTMLTextAreaElement, text: string): void {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  if (!valueSetter) {
    throw new Error("HTML textarea value setter is unavailable");
  }
  valueSetter.call(textarea, text);
  textarea.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
}

function ignoreTextChange(): void {}

function createTextRecorder(): TextRecorder {
  const changes: string[] = [];
  return {
    changes,
    onChangeText: (text) => changes.push(text),
  };
}

afterEach(() => {
  for (const mounted of mountedInputs.splice(0)) {
    act(() => mounted.root.unmount());
    mounted.container.remove();
  }
});

describe("ComposerTextInput web IME composition", () => {
  it("keeps locally typed text when its parent rerenders with a stale value", () => {
    const recorder = createTextRecorder();
    const mounted = mountInput(recorder.onChangeText);

    act(() => {
      typeFromIme(mounted.textarea, "locally typed");
      mounted.root.render(
        <ComposerTextInput
          text=""
          multiline={true}
          onChangeText={recorder.onChangeText}
          placeholder="rerender with stale publication"
          testID="composer-input"
        />,
      );
    });

    expect(mounted.textarea.value).toBe("locally typed");
    expect(recorder.changes).toEqual(["locally typed"]);
  });

  it("keeps the DOM-owned candidate during composition and reports the committed text", () => {
    const recorder = createTextRecorder();
    const mounted = mountInput(recorder.onChangeText);

    act(() => {
      dispatchComposition(mounted.textarea, "compositionstart");
      mounted.textarea.value = "你好";
      mounted.root.render(
        <ComposerTextInput
          text=""
          multiline={true}
          onChangeText={recorder.onChangeText}
          placeholder="rerender while composing"
          testID="composer-input"
        />,
      );
    });

    expect(mounted.textarea.value).toBe("你好");

    act(() => {
      dispatchComposition(mounted.textarea, "compositionend");
    });

    expect(recorder.changes).toEqual(["你好"]);
  });

  it("keeps the latest candidate across consecutive compositions", () => {
    const mounted = mountInput(ignoreTextChange);

    act(() => {
      dispatchComposition(mounted.textarea, "compositionstart");
      mounted.textarea.value = "你";
      dispatchComposition(mounted.textarea, "compositionend");
      dispatchComposition(mounted.textarea, "compositionstart");
      mounted.textarea.value = "你好";
      mounted.root.render(
        <ComposerTextInput
          text="你"
          multiline={true}
          onChangeText={ignoreTextChange}
          placeholder="second composition"
          testID="composer-input"
        />,
      );
    });

    expect(mounted.textarea.value).toBe("你好");
  });

  it("defers Korean IME input events until composition commits", () => {
    const changes: string[] = [];
    const mounted = mountInput((text) => changes.push(text));

    act(() => {
      dispatchComposition(mounted.textarea, "compositionstart");
      typeFromIme(mounted.textarea, "ㅎ");
      typeFromIme(mounted.textarea, "하");
      typeFromIme(mounted.textarea, "한");
    });

    expect(changes).toEqual([]);

    act(() => {
      dispatchComposition(mounted.textarea, "compositionend");
    });

    expect(changes).toEqual(["한"]);
  });

  it("reads the live DOM value for send-path text extraction during composition", () => {
    const inputRef = React.createRef<ComposerTextInputHandle>();
    const mounted = mountInput(ignoreTextChange, inputRef);
    let queuedText = "";

    act(() => {
      dispatchComposition(mounted.textarea, "compositionstart");
      typeFromIme(mounted.textarea, "old한");
      queuedText = mounted.inputRef.current?.getText() ?? "";
    });

    expect(queuedText).toBe("old한");
    expect(mounted.textarea.value).toBe("old한");

    act(() => {
      mounted.inputRef.current?.replaceText("");
    });

    expect(mounted.textarea.value).toBe("");
  });
});
