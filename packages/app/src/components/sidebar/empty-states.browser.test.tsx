import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n as testI18n } from "@/i18n/i18next";
import { DEFAULT_SIDEBAR_WIDTH } from "@/stores/panel-store";
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

// Translations of "Add project" and "Import session" can be wider than the default sidebar, so the
// action row has to wrap instead of pushing the second button past the card's border.
describe("SidebarProjectEmptyState", () => {
  it.each([
    ["ru", DEFAULT_SIDEBAR_WIDTH],
    ["en", DEFAULT_SIDEBAR_WIDTH],
  ])("keeps every action inside the card (%s, %ipx sidebar)", async (language, width) => {
    const card = await mountEmptyState(language, width);
    const cardRect = card.getBoundingClientRect();
    const buttons = Array.from(card.querySelectorAll<HTMLElement>('[role="button"]'));

    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      const rect = button.getBoundingClientRect();
      expect(rect.left).toBeGreaterThanOrEqual(cardRect.left);
      expect(rect.right).toBeLessThanOrEqual(cardRect.right);
    }
  });
});
