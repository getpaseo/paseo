import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { Button } from "@/components/ui/button";
import {
  SettingsCard,
  SettingsCollapsibleRow,
  SettingsDetailRow,
  SettingsRow,
  SettingsSwitch,
} from "@/components/settings";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function openNothing() {}
function toggleNothing() {}

function mountRows() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      <SettingsCard>
        <SettingsRow label="Card row" testID="card-row">
          <Button variant="outline" testID="card-button">
            Download
          </Button>
        </SettingsRow>
        <SettingsRow label="Text only" testID="text-row" />
        <SettingsSwitch
          label="Toggles"
          value={false}
          onValueChange={toggleNothing}
          testID="switch-row"
        />
        <SettingsDetailRow label="Opens a page" onPress={openNothing} testID="detail-row" />
        <SettingsCollapsibleRow label="Group" defaultExpanded testID="group">
          <SettingsRow label="Nested with a button" testID="nested-with-button">
            <Button variant="outline" testID="nested-button">
              Download
            </Button>
          </SettingsRow>
          <SettingsRow label="Nested without a button" testID="nested-without-button" />
        </SettingsCollapsibleRow>
      </SettingsCard>,
    ),
  );
}

function element(testID: string): HTMLElement {
  const found = document.querySelector(`[data-testid="${testID}"]`);
  if (!(found instanceof HTMLElement)) throw new Error(`Nothing rendered as ${testID}`);
  return found;
}

function heightOf(testID: string): number {
  return element(testID).getBoundingClientRect().height;
}

function textNode(rowTestID: string, text: string): HTMLElement {
  const found = [...element(rowTestID).querySelectorAll("div")].find(
    (node) => node.textContent === text && node.children.length === 0,
  );
  if (!found) throw new Error(`No text ${text}`);
  return found;
}

function titleFontSize(rowTestID: string, label: string): number {
  return Number.parseFloat(getComputedStyle(textNode(rowTestID, label)).fontSize);
}

describe("settings row density", () => {
  it("lines up nested rows with and without a button, tighter than card rows", () => {
    mountRows();

    expect(heightOf("nested-with-button")).toBe(heightOf("nested-without-button"));
    expect(heightOf("nested-with-button")).toBeLessThan(heightOf("card-row"));
    expect(heightOf("group-toggle")).toBeGreaterThan(heightOf("nested-without-button"));
  });

  it("lines up text, switch, and opening rows below a row holding a button", () => {
    mountRows();

    expect(heightOf("switch-row")).toBe(heightOf("text-row"));
    expect(heightOf("detail-row")).toBe(heightOf("text-row"));
    expect(heightOf("group-toggle")).toBe(heightOf("text-row"));
    expect(heightOf("card-row")).toBeGreaterThan(heightOf("text-row"));
  });

  it("sizes nested text and controls one step below card rows", () => {
    mountRows();

    expect(heightOf("nested-button")).toBeLessThan(heightOf("card-button"));
    expect(titleFontSize("nested-with-button", "Nested with a button")).toBeLessThan(
      titleFontSize("card-row", "Card row"),
    );
  });

  it("keeps a row with a long summary one line tall on a phone-width card", () => {
    container = document.createElement("div");
    // A 393pt phone less the sheet's side padding.
    container.style.width = "360px";
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root?.render(
        <SettingsCard>
          <SettingsRow label="Text only" testID="text-row" />
          <SettingsCollapsibleRow
            label="Customize settings"
            summary="Auto mode · Medium · 2 features · Add a note for when to use it"
            testID="long-summary"
          >
            <SettingsRow label="Nested" />
          </SettingsCollapsibleRow>
        </SettingsCard>,
      ),
    );

    expect(heightOf("long-summary-toggle")).toBe(heightOf("text-row"));
  });

  it("keeps a short summary beside the chevron on a wide card", () => {
    container = document.createElement("div");
    container.style.width = "680px";
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root?.render(
        <SettingsCard>
          <SettingsDetailRow
            label="Speech to text"
            summary="Local"
            onPress={openNothing}
            testID="short-summary"
          />
        </SettingsCard>,
      ),
    );

    const row = element("short-summary").getBoundingClientRect();
    const summary = textNode("short-summary", "Local").getBoundingClientRect();
    // The summary's margin, the chevron and the row's padding: about 40px.
    expect(row.right - summary.right).toBeLessThan(48);
  });
});
