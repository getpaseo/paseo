import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { i18n } from "@/i18n/i18next";
import { UsageWindowBar } from "./window-bar";
import type { UsageBalance, UsageWindow } from "./types";
import { UsageBalanceBar } from "./balance-bar";
import { UsageMeter } from "./meter";

const window: UsageWindow = { id: "session", label: "Session", usedPct: 70 };
const exhaustedWindow: UsageWindow = { ...window, usedPct: 100 };
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

it("colors healthy quota bars green and keeps the warning and danger colors", () => {
  act(() =>
    root.render(
      <>
        <UsageMeter percent={20} tone="default" />
        <UsageMeter percent={20} tone="ok" />
        <UsageMeter percent={20} tone="warning" />
        <UsageMeter percent={20} tone="danger" />
        <UsageMeter percent={20} tone="danger" quiet />
      </>,
    ),
  );
  const colors = Array.from(
    container.children,
    (track) => getComputedStyle(track.firstElementChild!).backgroundColor,
  );
  expect(colors).toEqual([
    "rgb(21, 128, 61)",
    "rgb(21, 128, 61)",
    "rgb(217, 119, 6)",
    "rgb(185, 28, 28)",
    "rgb(212, 212, 216)",
  ]);
});

it("keeps an exhausted quota red when a failed refresh removes its forecast", () => {
  act(() =>
    root.render(
      <UsageWindowBar
        window={exhaustedWindow}
        forecastAt={null}
        retained
        displayAs="used"
        pinnable={false}
        pinned={false}
        onTogglePin={ignorePin}
        pinLabel=""
        pinTestID=""
      />,
    ),
  );
  expect(container.textContent).toBe("Session100% used");
  const fill = container.firstElementChild!.children[1].firstElementChild!;
  expect(getComputedStyle(fill).backgroundColor).toBe("rgb(185, 28, 28)");
});

const narrowReadingMs = Date.now();
const narrowForecastAt = new Date(narrowReadingMs).toISOString();
const narrowWindow: UsageWindow = {
  id: "weekly",
  label: "Weekly",
  usedPct: 6,
  durationSeconds: 604_800,
  resetsAt: new Date(narrowReadingMs + 165.5 * 3_600_000).toISOString(),
};

const onTrackWindow: UsageWindow = {
  id: "session",
  label: "Session",
  usedPct: 40,
  durationSeconds: 18_000,
  resetsAt: new Date(narrowReadingMs + 3_600_000).toISOString(),
};
const tightWindow: UsageWindow = { ...onTrackWindow, usedPct: 77 };

it.each([
  ["green", onTrackWindow, "rgb(21, 128, 61)"],
  ["amber", tightWindow, "rgb(217, 119, 6)"],
] as const)("shows only the reset details for an on-track %s bar", (_, usageWindow, color) => {
  act(() =>
    root.render(
      <UsageWindowBar
        window={usageWindow}
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

  const row = container.firstElementChild!;
  const [label, track, datapoints] = row.children;
  expect(label.textContent).toBe(`Session${usageWindow.usedPct}% used`);
  expect(datapoints.textContent).toMatch(/^resets in [^·]+\s· [^·]+$/);
  expect(getComputedStyle(track.firstElementChild!).backgroundColor).toBe(color);
});

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
  expect(line?.textContent).toMatch(/^resets in [^·]+\s· [^·]+\s· runs out .+$/);
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
  const forecast = textBounds("épuisement prévu");
  expect(forecast.left >= countdown.right || forecast.top >= countdown.bottom).toBe(true);
});
