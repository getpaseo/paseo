import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAllByRole } from "@testing-library/dom";
import { i18n as testI18n } from "@/i18n/i18next";
import { DEFAULT_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH } from "@/stores/panel-store";
import { SidebarProjectEmptyState } from "./empty-states";

// App sources compile against the classic JSX runtime, which expects React on the global.
beforeEach(() => vi.stubGlobal("React", React));

interface Mounted {
  root: Root;
  container: HTMLDivElement;
}

const mounted: Mounted[] = [];

afterEach(async () => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
  await testI18n.changeLanguage("en");
});

async function mountEmptyState(language: string, width: number): Promise<HTMLElement> {
  await testI18n.changeLanguage(language);

  const container = document.createElement("div");
  container.style.width = `${width}px`;
  // Match the workspace list's horizontal inset around the card.
  container.style.paddingInline = "6px";
  container.style.boxSizing = "border-box";
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<SidebarProjectEmptyState />));
  mounted.push({ root, container });

  const card = container.querySelector('[data-testid="sidebar-project-empty-state"]');
  if (!(card instanceof HTMLElement)) {
    throw new Error("SidebarProjectEmptyState did not render its card");
  }
  return card;
}

function expectActionsInsideCard(card: HTMLElement) {
  const cardRect = card.getBoundingClientRect();
  const buttons = getAllByRole(card, "button");

  expect(buttons).toHaveLength(2);
  for (const button of buttons) {
    const rect = button.getBoundingClientRect();
    expect(rect.left).toBeGreaterThanOrEqual(cardRect.left);
    expect(rect.right).toBeLessThanOrEqual(cardRect.right);

    // Containing the button must also keep the whole label readable, without clipping.
    const label = document.createRange();
    label.selectNodeContents(button);
    for (const fragment of Array.from(label.getClientRects())) {
      expect(fragment.left).toBeGreaterThanOrEqual(rect.left);
      expect(fragment.right).toBeLessThanOrEqual(rect.right);
      expect(fragment.top).toBeGreaterThanOrEqual(rect.top);
      expect(fragment.bottom).toBeLessThanOrEqual(rect.bottom);
    }
  }
}

describe("SidebarProjectEmptyState", () => {
  const cases = ["en", "ru", "fr", "ja", "es", "pt-BR", "ar", "ko", "zh-CN"].flatMap((language) =>
    [MIN_SIDEBAR_WIDTH, DEFAULT_SIDEBAR_WIDTH].map((width) => ({ language, width })),
  );
  it.each(cases)(
    "keeps every action inside the card ($language, $width px sidebar)",
    async ({ language, width }) => {
      expectActionsInsideCard(await mountEmptyState(language, width));
    },
  );

  it("keeps English actions on one row when they fit", async () => {
    const card = await mountEmptyState("en", DEFAULT_SIDEBAR_WIDTH);
    const [addProject, importSession] = getAllByRole(card, "button");
    expect(addProject.getBoundingClientRect().top).toBe(importSession.getBoundingClientRect().top);
  });
});
