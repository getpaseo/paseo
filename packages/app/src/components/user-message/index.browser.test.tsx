import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Text, View } from "react-native";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MessagePreview } from "./index";

const PREVIEW_CAP = 240;

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

const frameStyle = { backgroundColor: "rgb(40, 40, 40)", alignItems: "flex-end" } as const;

function renderLongMessage(): void {
  act(() =>
    root.render(
      <View style={frameStyle}>
        <MessagePreview>
          <Text testID="user-message-text">
            {Array.from({ length: 40 }, (_, line) => `第 ${line + 1} 行必须留在气泡背景里面`).join(
              "\n",
            )}
          </Text>
        </MessagePreview>
      </View>,
    ),
  );
}

it("keeps a collapsed long message inside the preview instead of painting past it", async () => {
  renderLongMessage();
  const preview = host.querySelector<HTMLElement>('[data-testid="user-message-preview"]');
  const text = host.querySelector<HTMLElement>('[data-testid="user-message-text"]');
  if (!preview || !text) throw new Error("preview did not render");
  await vi.waitFor(() => expect(text.scrollHeight).toBeGreaterThan(PREVIEW_CAP));
  // The bubble sizes to this box. Text past the cap stays inside it.
  expect(preview.clientHeight).toBeLessThanOrEqual(PREVIEW_CAP);
  expect(preview.clientHeight).toBeGreaterThan(0);
  expect(preview.clientHeight).toBeLessThan(text.getBoundingClientRect().height);
  expect(getComputedStyle(preview).overflowY).not.toBe("visible");

  await vi.waitFor(() => expect(host.querySelector('[role="button"]')).toBeTruthy());
  const button = host.querySelector<HTMLElement>('[role="button"]');
  if (!button) throw new Error("expand control did not render");
  act(() => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await vi.waitFor(() =>
    expect(host.querySelector('[data-testid="user-message-preview"]')).toBeNull(),
  );
  const expanded = host.querySelector<HTMLElement>('[data-testid="user-message-text"]');
  expect(expanded?.getBoundingClientRect().height ?? 0).toBeGreaterThan(PREVIEW_CAP);
});
