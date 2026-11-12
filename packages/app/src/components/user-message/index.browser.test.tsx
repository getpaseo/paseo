import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { within } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n as testI18n } from "@/i18n/i18next";
import { MessagePreview } from "./index";
import { createUserMessageExpansion, type UserMessageExpansion } from "./expansion";
import { UserMessageExpansionContext } from "./expansion-context";

// Load translations so the toggle exposes its real accessible name.
void testI18n;

// App sources compile against the classic JSX runtime, which expects React on the global.
beforeEach(() => vi.stubGlobal("React", React));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  container.style.width = "400px";
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const longText = Array.from({ length: 60 }, (_, line) => `Line ${line + 1}`).join("\n");
const preLine = { whiteSpace: "pre-line" } as const;
const view = () => within(container);

function renderMessage(expansion: UserMessageExpansion) {
  act(() =>
    root.render(
      <UserMessageExpansionContext.Provider value={expansion}>
        <MessagePreview itemId="message-1">
          <span style={preLine}>{longText}</span>
        </MessagePreview>
      </UserMessageExpansionContext.Provider>,
    ),
  );
}

async function waitForLayout() {
  await act(async () => {
    for (let frame = 0; frame < 2; frame += 1) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  });
}

describe("long user message preview", () => {
  it("commits the control with the mount, so the first frame is the settled one", async () => {
    renderMessage(createUserMessageExpansion());

    // Nothing has painted yet: whatever is in the DOM now is the first frame.
    expect(view().getByRole("button", { name: "Show more" })).toBeTruthy();
    const firstFrameHeight = container.getBoundingClientRect().height;

    await waitForLayout();
    expect(view().getByRole("button", { name: "Show more" })).toBeTruthy();
    expect(container.getBoundingClientRect().height).toBe(firstFrameHeight);
  });

  it("paints the user's expanded choice when the row remounts", async () => {
    const expansion = createUserMessageExpansion();
    renderMessage(expansion);
    act(() => view().getByRole("button", { name: "Show more" }).click());
    await waitForLayout();
    const expandedHeight = container.getBoundingClientRect().height;

    act(() => root.render(null));
    renderMessage(expansion);

    expect(view().getByRole("button", { name: "Show less" })).toBeTruthy();
    expect(container.getBoundingClientRect().height).toBe(expandedHeight);
  });
});
