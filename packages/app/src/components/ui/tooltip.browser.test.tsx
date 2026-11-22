import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Text } from "react-native";
import { afterEach, beforeEach, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

let root: Root;
let container: HTMLDivElement;

const scrollerStyle = { height: 160, overflowY: "auto" } as const;
const spacerStyle = { height: 300 };

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it("keeps the tooltip anchored when tabbing to an offscreen trigger scrolls it into view", async () => {
  const scrollerRef = createRef<HTMLDivElement>();
  const offset = 6;
  act(() => {
    root.render(
      <>
        <button type="button">Before trigger</button>
        <div ref={scrollerRef} style={scrollerStyle}>
          <div style={spacerStyle} />
          <Tooltip>
            <TooltipTrigger accessibilityRole="button">
              <Text>Send</Text>
            </TooltipTrigger>
            <TooltipContent offset={offset}>
              <Text>Send message</Text>
            </TooltipContent>
          </Tooltip>
          <div style={spacerStyle} />
        </div>
        <button type="button">After trigger</button>
      </>,
    );
  });

  const scroller = scrollerRef.current;
  if (!scroller) throw new Error("Expected a scroll container");
  const trigger = page.getByRole("button", { name: "Send" });
  const tooltip = page.getByRole("tooltip");
  const gap = () =>
    trigger.element().getBoundingClientRect().top -
    tooltip.element().getBoundingClientRect().bottom;

  await page.getByRole("button", { name: "Before trigger" }).click();
  expect(scroller.scrollTop).toBe(0);
  await userEvent.keyboard("{Tab}");

  await expect.element(trigger).toHaveFocus();
  await expect.poll(() => scroller.scrollTop).toBeGreaterThan(0);
  await expect.element(tooltip).toBeVisible();
  await expect.poll(gap).toBeCloseTo(offset, 0);

  const nextScrollTop = scroller.scrollTop + 20;
  scroller.scrollTop = nextScrollTop;
  expect(scroller.scrollTop).toBe(nextScrollTop);
  await expect.poll(gap).toBeCloseTo(offset, 0);

  await userEvent.keyboard("{Tab}");
  await expect.element(page.getByRole("button", { name: "After trigger" })).toHaveFocus();
  await expect.element(tooltip).not.toBeInTheDocument();
});
