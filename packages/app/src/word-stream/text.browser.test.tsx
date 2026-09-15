import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { StreamingWords } from ".";
let WordFadeText: typeof import("./text.web").WordFadeText;

// The browser test runner uses classic JSX for RN source; provide the real runtime.
const previousReact = Reflect.get(globalThis, "React");
beforeAll(async () => {
  Reflect.set(globalThis, "React", React);
  // Loading the web bundle must also work on runtimes without Intl.Segmenter.
  const segmenter = Object.getOwnPropertyDescriptor(Intl, "Segmenter")!;
  Reflect.deleteProperty(Intl, "Segmenter");
  try {
    ({ WordFadeText } = await import("./text.web"));
  } finally {
    Object.defineProperty(Intl, "Segmenter", segmenter);
  }
});
afterAll(() => {
  if (previousReact === undefined) Reflect.deleteProperty(globalThis, "React");
  else Reflect.set(globalThis, "React", previousReact);
});

const textStyle = { fontSize: 24, fontFamily: "Arial" };
const paced = (text: string) => ({ text, spanMs: 60, streaming: true });
let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
});

async function reveal(text: string) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const content = (value: string) => (
    <StreamingWords stream={paced(value)}>
      <WordFadeText style={textStyle}>{value}</WordFadeText>
    </StreamingWords>
  );
  await act(async () => root!.render(content("")));
  await act(async () => root!.render(content(text)));
  return host;
}

it.each(["abcdefgh", "שלום", "العربية"])("fades %s in visual left-to-right order", async (text) => {
  const surface = await reveal(text);
  const animations = surface.getAnimations({ subtree: true });
  expect(animations.length).toBeGreaterThan(0);
  for (const animation of animations) {
    animation.pause();
    animation.currentTime = 65;
  }
  const word = surface.querySelector<HTMLElement>("[data-word-fade]")!;
  const letters = Array.from(word.children, (child) => ({
    left: child.getBoundingClientRect().left,
    opacity: Number(getComputedStyle(child).opacity),
  })).sort((a, b) => a.left - b.left);
  expect(letters[0]!.opacity).toBeGreaterThan(letters.at(-1)!.opacity);
  for (let index = 1; index < letters.length; index++) {
    expect(letters[index]!.opacity).toBeLessThanOrEqual(letters[index - 1]!.opacity);
  }
});

it.each(["office", "العربية", "👨‍👩‍👧‍👦", "café"])("preserves shaping and width for %s", async (text) => {
  const surface = await reveal(text);
  const word = surface.querySelector<HTMLElement>("[data-word-fade]")!;
  const width = word.getBoundingClientRect().width;
  const plain = document.createElement("span");
  plain.textContent = text;
  word.parentElement!.append(plain);
  expect(Math.abs(width - plain.getBoundingClientRect().width)).toBeLessThan(0.5);
});

it.each(["👨‍👩‍👧‍👦", "é", "🇺🇸", "가", "क्‍ष"])("fades the grapheme %s as one unit", async (text) => {
  const surface = await reveal(text);
  expect(surface.textContent).toBe(text);
  expect(surface.getAnimations({ subtree: true })).toHaveLength(1);
});

it("does not fade settled text again when its Markdown surface remounts", async () => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const content = (value: string, key: string) => (
    <StreamingWords stream={paced(value)}>
      <WordFadeText key={key} style={textStyle}>
        {value}
      </WordFadeText>
    </StreamingWords>
  );
  await act(async () => root!.render(content("", "paragraph")));
  await act(async () => root!.render(content("already visible ", "paragraph")));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
  });
  await act(async () => root!.render(content("already visible next ", "table")));
  const fading = Array.from(host.querySelectorAll("[data-word-fade]"), (word) => word.textContent);
  expect(fading).toEqual(["next"]);
});

it("does not re-fade repeated words when a paragraph becomes a table", async () => {
  const { default: Markdown } = await import("react-native-markdown-display");
  const { useWordFadeRules } = await import("./markdown");
  const { createAssistantMarkdownParser } = await import("@/utils/assistant-markdown-parser");
  const parser = createAssistantMarkdownParser({ streaming: true });
  const rules = {
    text: (node: { key: string; content: string }) => (
      <WordFadeText key={node.key}>{node.content}</WordFadeText>
    ),
  };
  function Body({ text }: { text: string }) {
    const mapped = useWordFadeRules(rules, 0);
    return (
      <Markdown markdownit={parser} rules={mapped}>
        {text}
      </Markdown>
    );
  }
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const render = async (text: string) =>
    act(async () =>
      root!.render(
        <StreamingWords stream={paced(text)}>
          <Body text={text} />
        </StreamingWords>,
      ),
    );
  await render("");
  await render("| same | same |\n");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
  });
  await render("| same | same |\n| --- | --- |\n| same | next |\n");
  const words = Array.from(host.querySelectorAll("[data-word-fade]"), (word) => word.textContent);
  expect(words).toEqual(["same", "next"]);
});

it("continues one front across a word boundary instead of restarting it", async () => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const content = (value: string) => (
    <StreamingWords stream={paced(value)}>
      <WordFadeText style={textStyle}>{value}</WordFadeText>
    </StreamingWords>
  );
  await act(async () => root!.render(content("")));
  await act(async () => root!.render(content("abcdefgh ")));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
  await act(async () => root!.render(content("abcdefgh ijkl ")));
  for (const animation of host.getAnimations({ subtree: true })) animation.pause();
  const letters = Array.from(
    host.querySelectorAll<HTMLElement>("[data-word-fade] > span"),
    (el) => ({
      text: el.textContent,
      left: el.getBoundingClientRect().left,
      start: Number(el.dataset.fadeStart),
      opacity: Number(getComputedStyle(el).opacity),
    }),
  ).sort((a, b) => a.left - b.left);
  expect(letters.map((l) => l.text).join("")).toBe("abcdefghijkl");
  for (let index = 1; index < letters.length; index++) {
    const label = `${letters[index]!.text} after ${letters[index - 1]!.text}`;
    expect(letters[index]!.start, label).toBeGreaterThanOrEqual(letters[index - 1]!.start);
    expect(letters[index]!.opacity, label).toBeLessThanOrEqual(letters[index - 1]!.opacity + 0.01);
  }
  // "i" starts after "h", and the front keeps moving inside each word.
  expect(letters[8]!.start).toBeGreaterThan(letters[7]!.start);
  expect(letters[1]!.start).toBeGreaterThan(letters[0]!.start);
});

it("removes the final word's animation spans without another text update", async () => {
  const surface = await reveal("final");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
  });
  expect(surface.querySelectorAll("[data-word-fade]")).toHaveLength(0);
  expect(surface.textContent).toBe("final");
});
