import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useComposerHeight } from "./height.web";
import type { ComposerHeightResult } from "./height.types";

const MIN_HEIGHT = 40;
const MAX_HEIGHT = 400;

interface Mounted {
  root: Root;
  container: HTMLDivElement;
  textarea: HTMLTextAreaElement;
  latest: () => ComposerHeightResult;
  textRef: { current: string };
  setValue: (value: string) => void;
}

const mounted: Mounted[] = [];

interface ResultSink {
  record: (result: ComposerHeightResult) => void;
  latest: () => ComposerHeightResult;
}

function createResultSink(): ResultSink {
  let latest: ComposerHeightResult | null = null;
  return {
    record: (result) => {
      latest = result;
    },
    latest: () => {
      if (!latest) throw new Error("Hook has not rendered");
      return latest;
    },
  };
}

const TEXTAREA_STYLE: React.CSSProperties = {
  width: 320,
  fontSize: 16,
  lineHeight: "24px",
  padding: 8,
  boxSizing: "border-box",
  overflow: "hidden",
};

function Probe({
  textRef,
  sink,
  textareaRef,
}: {
  textRef: { current: string };
  sink: ResultSink;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  // The composer holds live text in a ref and reports every edit through onTextChange, so the
  // hook reads the text through a stable getter rather than a prop.
  const getText = React.useCallback(() => textRef.current, [textRef]);
  const result = useComposerHeight({
    getText,
    textareaRef,
    minHeight: MIN_HEIGHT,
    maxHeight: MAX_HEIGHT,
  });
  sink.record(result);
  const style = React.useMemo(
    () => ({ ...TEXTAREA_STYLE, height: measuredHeight(result) }),
    [result],
  );
  return <textarea ref={textareaRef} value={textRef.current} readOnly style={style} />;
}

function renderProbe(
  root: Root,
  textRef: { current: string },
  sink: ResultSink,
  textareaRef: React.RefObject<HTMLTextAreaElement | null>,
): void {
  root.render(<Probe textRef={textRef} sink={sink} textareaRef={textareaRef} />);
}

function mountProbe(): Mounted {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const textareaRef = React.createRef<HTMLTextAreaElement | null>();
  const sink = createResultSink();
  const textRef = { current: "" };
  act(() => renderProbe(root, textRef, sink, textareaRef));
  const textarea = container.querySelector("textarea");
  if (!textarea) throw new Error("Probe did not render a textarea");
  const entry: Mounted = {
    root,
    container,
    textarea,
    latest: sink.latest,
    textRef,
    setValue: (value) =>
      act(() => {
        const result = sink.latest();
        if (result.mode === "measured") result.onTextChange(textRef.current, value);
        textRef.current = value;
        renderProbe(root, textRef, sink, textareaRef);
      }),
  };
  mounted.push(entry);
  return entry;
}

function measuredHeight(result: ComposerHeightResult): number {
  if (result.mode !== "measured") throw new Error("Web composer height must be measured");
  const height = result.style.height;
  if (typeof height !== "number") throw new Error("Height must be a number");
  return height;
}

function typeIntoComposer(probe: Mounted, text: string): void {
  const result = probe.latest();
  if (result.mode !== "measured") throw new Error("Web composer height must be measured");
  let previous = "";
  for (let length = 1; length <= text.length; length += 1) {
    const next = text.slice(0, length);
    act(() => {
      result.onTextChange(previous, next);
      probe.textRef.current = next;
    });
    previous = next;
  }
}

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

describe("useComposerHeight on web", () => {
  it("grows with the typed lines and returns to the minimum when cleared", () => {
    const probe = mountProbe();
    expect(measuredHeight(probe.latest())).toBe(MIN_HEIGHT);

    typeIntoComposer(probe, "one\ntwo\nthree\nfour");
    const grown = measuredHeight(probe.latest());
    expect(grown).toBeGreaterThan(MIN_HEIGHT);
    expect(grown).toBeLessThanOrEqual(MAX_HEIGHT);

    probe.setValue("one\ntwo\nthree\nfour");
    expect(measuredHeight(probe.latest())).toBe(grown);

    probe.setValue("");
    expect(measuredHeight(probe.latest())).toBe(MIN_HEIGHT);
  });

  it("reads computed style on mount only, never per keystroke", () => {
    const originalGetComputedStyle = window.getComputedStyle;
    const calls = { count: 0 };
    window.getComputedStyle = function countedGetComputedStyle(
      this: Window,
      ...args: Parameters<typeof originalGetComputedStyle>
    ) {
      calls.count += 1;
      return originalGetComputedStyle.apply(this, args);
    };
    try {
      const probe = mountProbe();
      const mountReads = calls.count;
      expect(mountReads).toBe(1);

      const text = "The quick brown fox jumps over the lazy dog.\n".repeat(4);
      typeIntoComposer(probe, text);
      probe.setValue(text);

      expect(calls.count - mountReads).toBe(0);
      expect(measuredHeight(probe.latest())).toBeGreaterThan(MIN_HEIGHT);
    } finally {
      window.getComputedStyle = originalGetComputedStyle;
    }
  });

  it("re-measures after the textarea changes width", async () => {
    const probe = mountProbe();
    const longLine = "word ".repeat(40);
    probe.setValue(longLine);
    const wideHeight = measuredHeight(probe.latest());

    probe.textarea.style.width = "120px";
    await vi.waitFor(() => {
      expect(measuredHeight(probe.latest())).toBeGreaterThan(wideHeight);
    });
  });
});
