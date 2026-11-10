import React, { act, useMemo } from "react";
import { createRoot, type Root } from "react-dom/client";
import { View } from "react-native";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TailEllipsisText } from "./index";

// App sources compile against the classic JSX runtime, which expects React on the global.
beforeEach(() => vi.stubGlobal("React", React));

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const TEXT_STYLE = { fontSize: 16, fontFamily: "monospace" } as const;

function LabelRow({ text, width }: { text: string; width: number }) {
  const rowStyle = useMemo(() => ({ width, flexDirection: "row" as const }), [width]);
  return (
    <View style={rowStyle}>
      <TailEllipsisText text={text} style={TEXT_STYLE} testID="label" />
    </View>
  );
}

function renderLabel(text: string, width: number): void {
  act(() => root.render(<LabelRow text={text} width={width} />));
}

function shownLabel(): { text: string; visible: boolean } {
  const label = host.querySelector<HTMLElement>('[data-testid="label"]');
  if (!label) throw new Error("label did not render");
  return { text: label.textContent ?? "", visible: getComputedStyle(label).opacity !== "0" };
}

it("shows a replacement label that shares its shortened prefixes with the previous one", async () => {
  // Wide enough for "Ten second…" in monospace, too narrow for either full label.
  const width = 12 * 10;
  renderLabel("Ten second stream", width);
  await vi.waitFor(() => expect(shownLabel()).toEqual({ text: "Ten second…", visible: true }));

  renderLabel("Ten second thread", width);
  await vi.waitFor(() => expect(shownLabel()).toEqual({ text: "Ten second…", visible: true }));
});

it("shows a replacement label as wide as the previous one", async () => {
  renderLabel("Opus 4.7", 400);
  await vi.waitFor(() => expect(shownLabel()).toEqual({ text: "Opus 4.7", visible: true }));

  renderLabel("Opus 4.8", 400);
  await vi.waitFor(() => expect(shownLabel()).toEqual({ text: "Opus 4.8", visible: true }));
});
