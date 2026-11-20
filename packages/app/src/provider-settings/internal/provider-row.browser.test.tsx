import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { within } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Text } from "react-native";
import { i18n as testI18n } from "@/i18n/i18next";
import { ProviderRow } from "./provider-row";
import type { RowSummary } from "./row-summary";

// Load translations so rows expose their real accessible names and copy.
void testI18n;

// App sources compile against the classic JSX runtime, which expects React on the global.
beforeEach(() => vi.stubGlobal("React", React));

const mounted: { root: Root; container: HTMLDivElement }[] = [];
afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

const ICON = <Text testID="provider-icon">*</Text>;

function mount(summary: RowSummary, options: { enabled?: boolean; label?: string } = {}) {
  const onOpen = vi.fn();
  const onToggle = vi.fn();
  const label = options.label ?? "Claude";
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <ProviderRow
        provider="claude"
        label={label}
        icon={ICON}
        summary={summary}
        enabled={options.enabled ?? true}
        toggling={false}
        onOpen={onOpen}
        onToggle={onToggle}
      />,
    ),
  );
  mounted.push({ root, container });
  const view = within(container);
  return {
    view,
    onOpen,
    onToggle,
    row: () => view.getByTestId("provider-row-claude"),
    opener: () => view.getByRole("button", { name: `${label} provider details` }),
    toggle: () => view.queryByRole("switch", { name: `Enable ${label}` }),
  };
}

function pressEnter(target: HTMLElement) {
  target.focus();
  for (const type of ["keydown", "keyup"]) {
    target.dispatchEvent(
      new KeyboardEvent(type, { key: "Enter", bubbles: true, cancelable: true }),
    );
  }
}

function textOrder(row: HTMLElement, texts: string[]): number[] {
  const content = row.textContent ?? "";
  return texts.map((text) => content.indexOf(text));
}

describe("provider row", () => {
  it("names the provider with its label and says Disabled when it is off", () => {
    const row = mount({ kind: "disabled" }, { enabled: false, label: "Codex" });
    expect(row.row().textContent).toContain("Codex");
    expect(row.view.getByText("Disabled")).toBeTruthy();
    expect(row.toggle()?.getAttribute("aria-checked")).toBe("false");
  });

  it("composes the row as icon, label, version and models, then switch", () => {
    const row = mount({ kind: "ready", version: "2.1.321", models: 3 });
    const element = row.row();
    expect(row.view.getByText("2.1.321 · 3 models")).toBeTruthy();
    const [icon, label, summary] = textOrder(element, ["*", "Claude", "2.1.321 · 3 models"]);
    expect(icon).toBeLessThan(label);
    expect(label).toBeLessThan(summary);
    const toggle = row.toggle();
    expect(toggle).not.toBeNull();
    expect(
      row.view.getByText("2.1.321 · 3 models").compareDocumentPosition(toggle as Node) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("asks its host to open the provider when the row is pressed", () => {
    const row = mount({ kind: "disabled" }, { enabled: false });
    act(() => row.opener().click());
    expect(row.onOpen).toHaveBeenCalledWith("claude");
  });

  it("keeps the switch out of the row's button, so Enter on the switch only toggles", () => {
    const row = mount({ kind: "ready", version: null, models: 3 });
    const toggle = row.toggle() as HTMLElement;
    expect(row.opener().contains(toggle)).toBe(false);
    // Dispatched in one act, so the test ends before the Switch's animation runs a frame.
    act(() => pressEnter(toggle));
    expect(row.onToggle).toHaveBeenCalledWith("claude", false);
    expect(row.onOpen).not.toHaveBeenCalled();
  });

  it("toggles the provider from the switch without opening it", () => {
    const row = mount({ kind: "ready", version: null, models: 3 });
    act(() => row.toggle()?.click());
    expect(row.onToggle).toHaveBeenCalledWith("claude", false);
    expect(row.onOpen).not.toHaveBeenCalled();
  });

  it("leaves the state line readable to screen readers, and the name to the row's button", () => {
    const row = mount({ kind: "failing", message: "opencode exited with code 1" });
    expect(row.view.getByText("opencode exited with code 1").closest("[aria-hidden]")).toBeNull();
    expect(row.view.getByText("Claude").closest("[aria-hidden]")).not.toBeNull();
  });

  it("says an update is available after the version", () => {
    const row = mount({ kind: "updateAvailable", version: "2.1.321" });
    expect(row.view.getByText("2.1.321 · Update available")).toBeTruthy();
  });

  it("names the target while an update runs, or says Updating... without one", () => {
    expect(
      mount({ kind: "updating", target: "1.0.31" }).view.getByText("Updating to 1.0.31..."),
    ).toBeTruthy();
    expect(mount({ kind: "updating", target: null }).view.getByText("Updating...")).toBeTruthy();
  });

  it("shows the error in the hint", () => {
    const row = mount({ kind: "failing", message: "opencode exited with code 1" });
    expect(row.view.getByText("opencode exited with code 1")).toBeTruthy();
    expect(row.toggle()).not.toBeNull();
  });

  it("offers no switch on a provider that is not installed", () => {
    const row = mount({ kind: "notInstalled" });
    expect(row.view.getByText("Not installed")).toBeTruthy();
    expect(row.toggle()).toBeNull();
    act(() => row.opener().click());
    expect(row.onOpen).toHaveBeenCalledWith("claude");
  });

  it("keeps the row as tall while its line loads as once it has arrived", () => {
    const pending = mount({ kind: "pending" }).row().getBoundingClientRect().height;
    const ready = mount({ kind: "ready", version: "2.1.321", models: 3 })
      .row()
      .getBoundingClientRect().height;
    const updating = mount({ kind: "updating", target: "1.0.31" })
      .row()
      .getBoundingClientRect().height;
    const failing = mount({ kind: "failing", message: "boom" })
      .row()
      .getBoundingClientRect().height;
    expect(pending).toBe(ready);
    expect(updating).toBe(ready);
    expect(failing).toBe(ready);
  });

  it("keeps a long, multi-line error to the row's one line", () => {
    const ready = mount({ kind: "ready", version: "2.1.321", models: 3 })
      .row()
      .getBoundingClientRect().height;
    const message = [
      "ACP agent process exited before initialization completed (exit code 1)",
      "broken-acp: exited with code 1",
    ].join("\n");
    const failing = mount({ kind: "failing", message }).row().getBoundingClientRect().height;
    expect(failing).toBe(ready);
  });
});
