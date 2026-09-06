import { describe, expect, it } from "vitest";
import {
  createGenericBrowserElementContext,
  formatBrowserElementContext,
  type BrowserElementContext,
} from "./element-context";

describe("browser element context", () => {
  it("builds semantic generic fields without exposing password values", () => {
    const password = createGenericBrowserElementContext({
      tag: "input",
      selector: "#password",
      text: "",
      attributes: { type: "password" },
      runtimeProperties: { value: "secret" },
      computedStyles: { color: "rgb(10, 20, 30)", opacity: "1" },
    });
    expect(password.fields).toEqual([
      {
        id: "color",
        path: "style.color",
        label: "Text color",
        editor: "color",
        value: "rgb(10, 20, 30)",
        group: "Appearance",
      },
      {
        id: "opacity",
        path: "style.opacity",
        label: "Opacity",
        editor: "slider",
        value: 1,
        min: 0,
        max: 1,
        step: 0.05,
        group: "Appearance",
      },
    ]);
  });

  it("uses low-input controls for common typography styles", () => {
    const context = createGenericBrowserElementContext({
      tag: "p",
      selector: "#summary",
      text: "Summary",
      computedStyles: {
        "font-family": 'Inter, "Noto Sans", sans-serif',
        "font-size": "14.56px",
        "font-weight": "400",
      },
    });

    expect(context.fields.slice(1)).toEqual([
      expect.objectContaining({
        id: "font-family",
        editor: "select",
        value: 'Inter, "Noto Sans", sans-serif',
      }),
      expect.objectContaining({
        id: "font-size",
        editor: "number",
        value: 14.56,
        unit: "px",
      }),
      expect.objectContaining({
        id: "font-weight",
        editor: "select",
        value: "400",
      }),
    ]);
  });

  it("does not offer destructive text replacement for elements with child markup", () => {
    const context = createGenericBrowserElementContext({
      tag: "button",
      selector: "#save",
      text: "Save changes",
      computedStyles: {},
      runtimeProperties: { hasChildElements: true },
    });

    expect(context.fields).toEqual([]);
  });

  it("maps native select state to a structured editor", () => {
    const context = createGenericBrowserElementContext({
      tag: "select",
      selector: "#region",
      text: "North",
      computedStyles: {},
      runtimeProperties: {
        value: ["north"],
        multiple: true,
        options: [
          { label: "North", value: "north" },
          { label: "South", value: "south" },
        ],
      },
    });
    expect(context.fields[0]).toEqual({
      id: "value",
      label: "Value",
      editor: "multiselect",
      value: ["north"],
      options: [
        { label: "North", value: "north" },
        { label: "South", value: "south" },
      ],
      group: "Content",
    });
  });

  it.each([
    ["radio", "boolean", "checked", true],
    ["range", "slider", "value", "4"],
    ["color", "color", "value", "#336699"],
    ["date", "date", "value", "2026-09-04"],
    ["time", "time", "value", "18:30"],
    ["datetime-local", "datetime", "value", "2026-09-04T18:30"],
  ])("maps %s inputs to the %s editor", (type, editor, fieldId, value) => {
    const context = createGenericBrowserElementContext({
      tag: "input",
      selector: `#${type}`,
      text: "",
      attributes: { type },
      computedStyles: {},
      runtimeProperties: { value, checked: value === true },
    });

    expect(context.fields[0]).toMatchObject({ id: fieldId, editor, value });
  });

  it("formats falsy requested changes without dropping them", () => {
    const context: BrowserElementContext = {
      version: 1,
      provider: { id: "dom" },
      target: { id: "button-42", label: "Button" },
      fields: [
        { id: "visible", label: "Visible", editor: "boolean", value: true },
        {
          id: "count",
          label: "Count",
          editor: "number",
          value: 1,
          required: true,
          min: 0,
          max: 10,
          step: 1,
          unit: "px",
        },
      ],
    };
    const formatted = formatBrowserElementContext(context, [
      { fieldId: "visible", from: true, to: false },
      { fieldId: "count", path: "props.count", from: 1, to: 0 },
    ]);
    expect(formatted).toContain('<element-context trust="untrusted-page-data" encoding="json">');
    const payload = JSON.parse(formatted.split("\n")[2] ?? "null");
    expect(payload.context.fields[1]).toMatchObject({
      required: true,
      min: 0,
      max: 10,
      step: 1,
      unit: "px",
    });
    expect(payload.requestedChanges).toEqual([
      { fieldId: "visible", from: true, to: false },
      { fieldId: "count", path: "props.count", from: 1, to: 0 },
    ]);
  });
});
