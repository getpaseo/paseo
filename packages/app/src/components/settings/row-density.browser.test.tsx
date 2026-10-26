import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { Button } from "@/components/ui/button";
import { SettingsCard, SettingsCollapsibleRow, SettingsRow } from "@/components/settings";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

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

function titleFontSize(rowTestID: string, label: string): number {
  const title = [...element(rowTestID).querySelectorAll("div")].find(
    (node) => node.textContent === label && node.children.length === 0,
  );
  if (!title) throw new Error(`No title ${label}`);
  return Number.parseFloat(getComputedStyle(title).fontSize);
}

describe("settings row density", () => {
  it("lines up nested rows with and without a button, tighter than card rows", () => {
    mountRows();

    expect(heightOf("nested-with-button")).toBe(heightOf("nested-without-button"));
    expect(heightOf("nested-with-button")).toBeLessThan(heightOf("card-row"));
    expect(heightOf("group-toggle")).toBeGreaterThan(heightOf("nested-without-button"));
  });

  it("sizes nested text and controls one step below card rows", () => {
    mountRows();

    expect(heightOf("nested-button")).toBeLessThan(heightOf("card-button"));
    expect(titleFontSize("nested-with-button", "Nested with a button")).toBeLessThan(
      titleFontSize("card-row", "Card row"),
    );
  });
});
