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
          forecastAt={null}
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

const narrowReadingMs = Date.now();
const narrowForecastAt = new Date(narrowReadingMs).toISOString();
const narrowWindow: UsageWindow = {
  id: "weekly",
  label: "Weekly",
  usedPct: 0.2,
  durationSeconds: 604_800,
  resetsAt: new Date(narrowReadingMs + 165.5 * 3_600_000).toISOString(),
};

it("shows the forecast as one more datapoint after the reset countdown, in the same line", async () => {
  act(() =>
    root.render(
      <UsageWindowBar
        window={narrowWindow}
        forecastAt={narrowForecastAt}
        displayAs="used"
        pinnable={false}
        pinned={false}
        onTogglePin={ignorePin}
        pinLabel=""
        pinTestID=""
      />,
    ),
  );

  const line = Array.from(container.querySelectorAll("*")).find((node) =>
    node.textContent.startsWith("resets in"),
  );
  expect(line?.textContent).toMatch(/^resets in .+\s· .+\s· ~\d+% left at reset$/);
});

it("wraps the forecast below the countdown in a narrow French card instead of overlapping it", async () => {
  await i18n.changeLanguage("fr");
  container.style.width = "272px";
  act(() =>
    root.render(
      <UsageWindowBar
        window={narrowWindow}
        forecastAt={narrowForecastAt}
        displayAs="used"
        pinnable={false}
        pinned={false}
        onTogglePin={ignorePin}
        pinLabel=""
        pinTestID=""
      />,
    ),
  );

  function textBounds(prefix: string) {
    const element = Array.from(container.querySelectorAll("*")).find(
      (node) => node.childElementCount === 0 && node.textContent.startsWith(prefix),
    );
    expect(element).toBeDefined();
    const range = document.createRange();
    range.selectNodeContents(element!);
    return range.getBoundingClientRect();
  }

  const countdown = textBounds("se réinitialise");
  const forecast = textBounds("~");
  expect(forecast.left >= countdown.right || forecast.top >= countdown.bottom).toBe(true);
});
