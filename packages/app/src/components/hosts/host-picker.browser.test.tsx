import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { HostPickerOption } from "./host-picker";

const actions: string[] = [];
function select() {
  actions.push("select");
}
function openSettings() {
  actions.push("settings");
}

it("keeps host selection and settings as separate accessible buttons", () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  actions.length = 0;
  act(() =>
    root.render(
      <HostPickerOption
        serverId="host-a"
        label="Host A"
        showActiveConnection={false}
        active={false}
        onPress={select}
        onOpenHostSettings={openSettings}
      />,
    ),
  );
  const host = container.querySelector('button[aria-label="Host A"]');
  const settings = container.querySelector('button[aria-label="Open Host A settings"]');
  expect(host).not.toBeNull();
  expect(settings).not.toBeNull();
  expect(host?.contains(settings!)).toBe(false);
  act(() => (settings as HTMLElement).click());
  expect(actions).toEqual(["settings"]);
  act(() => (host as HTMLElement).click());
  expect(actions).toEqual(["settings", "select"]);
  act(() => root.unmount());
  container.remove();
});
