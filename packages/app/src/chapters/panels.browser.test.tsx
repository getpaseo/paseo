import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { page } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import type { ChapterStory } from "@getpaseo/protocol/messages";
import { ChaptersOutline, type ChapterPresentationState } from "./outline";
import { en } from "@/i18n/resources/en";
const state = vi.hoisted(() => ({
  result: null as ChapterPresentationState | null,
  target: { kind: "chapter", selectionId: "remember", category: false },
  open: vi.fn(),
  regenerate: vi.fn(),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) => {
      let value: unknown = en;
      const resolvedKey = options?.count === 1 && key === "chapters.lines" ? `${key}_one` : key;
      for (const part of resolvedKey.split(".")) value = (value as Record<string, unknown>)?.[part];
      return typeof value === "string"
        ? value.replace("{{count}}", String(options?.count ?? ""))
        : key;
    },
  }),
}));
const story: ChapterStory = {
  fingerprint: "snapshot",
  createdAt: "2026-09-17T00:00:00.000Z",
  comparison: { mode: "uncommitted", ignoreWhitespace: false },
  files: [
    {
      path: "workspace.ts",
      isNew: true,
      isDeleted: false,
      additions: 2,
      deletions: 0,
      hunks: [
        {
          oldStart: 0,
          oldCount: 0,
          newStart: 1,
          newCount: 2,
          lines: [
            { type: "add", content: "rememberWorkspace(id);" },
            { type: "add", content: "restoreWorkspace();" },
          ],
        },
      ],
    },
  ],
  outline: {
    categories: [],
    chapters: [
      {
        id: "remember",
        title: "Remember the workspace",
        description: "The app saves the workspace you last used.",
        sections: [{ fileIndex: 0, hunkIndex: 0, startLine: 0, endLine: 1 }],
      },
      {
        id: "restore",
        title: "Return on launch",
        description: "Startup uses your saved choice to reopen the workspace.",
        sections: [{ fileIndex: 0, hunkIndex: 0, startLine: 1, endLine: 2 }],
      },
    ],
  },
};
let root: Root;
let container: HTMLDivElement;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  state.open.mockClear();
  state.regenerate.mockClear();
});
function mount(width = 1000) {
  container = document.createElement("div");
  container.style.cssText = `width:${width}px;height:700px;display:flex`;
  document.body.appendChild(container);
  root = createRoot(container);
  state.result = {
    supported: true,
    connected: true,
    stale: false,
    pending: false,
    error: null,
    story,
    state: { status: "ready", story, error: null, currentFingerprint: "snapshot" },
    regenerate: state.regenerate,
  };
}
function renderOutline() {
  const chapters = state.result;
  if (!chapters) throw new Error("Mount first");
  act(() => root.render(<ChaptersOutline chapters={chapters} openTab={state.open} />));
}
function clickButton(text: string) {
  const button = [...container.querySelectorAll<HTMLElement>('[role="button"]')].find(
    (entry) => entry.textContent === text,
  );
  expect(button).not.toBeUndefined();
  act(() => button!.click());
}
it.each([360, 1000])("opens the selected chapter from the outline at %ipx", async (width) => {
  mount(width);
  renderOutline();
  expect(container.textContent).toContain("Remember the workspace");
  expect(container.textContent).toContain("1 changed line");
  await page.screenshot({ path: `/tmp/chapters-outline-${width}.png`, element: container });
  const row = container.querySelector<HTMLElement>('[data-testid="chapter-row-restore"]');
  expect(row).not.toBeNull();
  act(() => row!.click());
  expect(state.open).toHaveBeenCalledWith({
    kind: "chapter",
    selectionId: "restore",
    category: false,
  });
});
it("keeps the story visible after generation failure and offers regeneration", () => {
  mount();
  state.result = { ...state.result!, stale: true, error: "Provider unavailable" };
  renderOutline();
  expect(container.textContent).toContain("You are reading an older version");
  expect(container.textContent).toContain("Provider unavailable");
  expect(container.textContent).toContain("Return on launch");
  clickButton("Regenerate");
  expect(state.regenerate).toHaveBeenCalledTimes(1);
});
it("shows host capability and connection messages", () => {
  mount();
  state.result = { ...state.result!, story: null, supported: false };
  renderOutline();
  expect(container.textContent).toContain("Update the host to use Chapters");
  state.result = { ...state.result!, connected: false };
  renderOutline();
  expect(container.textContent).toContain("Reconnect to load or update chapters");
});

it("opens category introductions and collapses their chapters", () => {
  mount();
  state.result = {
    ...state.result!,
    story: {
      ...story,
      outline: {
        ...story.outline,
        categories: [
          {
            id: "journey",
            title: "Remember and return",
            description: "Keep the workspace between visits.",
            chapterIds: ["remember", "restore"],
          },
        ],
      },
    },
  };
  renderOutline();
  clickButton("Remember and return");
  expect(state.open).toHaveBeenCalledWith({
    kind: "chapter",
    selectionId: "journey",
    category: true,
  });
  clickButton("−");
  expect(container.textContent).not.toContain("Return on launch");
  clickButton("+");
  expect(container.textContent).toContain("Return on launch");
});
