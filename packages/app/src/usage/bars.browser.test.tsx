import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { i18n } from "@/i18n/i18next";
import { UsageWindowBar } from "./window-bar";
import type { UsageBalance, UsageWindow } from "./types";
import { UsageBalanceBar } from "./balance-bar";

const window: UsageWindow = { id: "session", label: "Session", usedPct: 70 };
const balance: UsageBalance = { id: "credits", label: "Credits", unit: "usd", remaining: 12 };
const ignorePin = () => {};

let root: Root;
let container: HTMLDivElement;
beforeEach(async () => {
  vi.stubGlobal("React", React);
  await i18n.changeLanguage("en");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  act(() => root.unmount());
  container.remove();
  await i18n.changeLanguage("en");
  vi.unstubAllGlobals();
});

it("translates mounted usage rows when the language changes", async () => {
  act(() =>
    root.render(
      <>
        <UsageWindowBar
          window={window}
          displayAs="used"
          pinnable={false}
          pinned={false}
          onTogglePin={ignorePin}
          pinLabel=""
          pinTestID=""
        />
        <UsageBalanceBar balance={balance} />
      </>,
    ),
  );
  expect(container.textContent).toContain("Session70% used");
  expect(container.textContent).toContain("Credits");
  await act(async () => {
    await i18n.changeLanguage("ja");
  });
  expect(container.textContent).toContain("セッション70% 使用済み");
  expect(container.textContent).toContain("クレジット");
});
