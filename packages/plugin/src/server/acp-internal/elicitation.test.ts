import type { CreateElicitationRequest } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import {
  buildElicitationContent,
  buildQuestionInputs,
  parseElicitationForm,
} from "./elicitation.js";

function form(properties: Record<string, unknown>): CreateElicitationRequest {
  return {
    sessionId: "s",
    message: "Question",
    mode: "form",
    requestedSchema: { type: "object", properties },
  } as CreateElicitationRequest;
}

const agy = form({
  q1: {
    type: "string",
    title: "Which?",
    oneOf: [
      { const: "1", title: "alpha" },
      { const: "2", title: "beta" },
    ],
  },
  q1_other: { type: "string", title: "Other" },
});

describe("parseElicitationForm", () => {
  it("folds the sibling _other property into the choice question", () => {
    const parsed = parseElicitationForm(agy)!;
    expect(buildQuestionInputs(parsed)).toEqual([
      {
        id: "q1",
        header: "Which?",
        question: "Which?",
        options: [
          { label: "alpha", description: "" },
          { label: "beta", description: "" },
        ],
        multiSelect: false,
        allowOther: true,
      },
    ]);
  });

  it("maps enum, boolean, multi-select and free text fields", () => {
    const parsed = parseElicitationForm(
      form({
        size: { type: "string", title: "Size", enum: ["S", "L"] },
        ok: { type: "boolean", title: "Sure?" },
        tags: { type: "array", title: "Tags", items: { anyOf: [{ const: "a", title: "Alpha" }] } },
        note: { type: "string", title: "Note", description: "Any note" },
      }),
    )!;
    expect(
      buildQuestionInputs(parsed).map((q) => [q.id, q.multiSelect, q.allowOther, q.question]),
    ).toEqual([
      ["size", false, false, "Size"],
      ["ok", false, false, "Sure?"],
      ["tags", true, false, "Tags"],
      ["note", false, true, "Any note"],
    ]);
  });

  it.each([
    ["url mode", { ...agy, mode: "url" } as CreateElicitationRequest],
    ["number property", form({ n: { type: "number" } })],
    ["no properties", form({})],
    ["unreadable choice list", form({ c: { type: "string", oneOf: [{ title: "x" }] } })],
  ])("returns null for %s", (_name, request) => {
    expect(parseElicitationForm(request)).toBeNull();
  });

  it("keeps headers unique so answers cannot collide", () => {
    const parsed = parseElicitationForm(
      form({ a: { type: "string", title: "Same" }, b: { type: "string", title: "Same" } }),
    )!;
    expect(buildQuestionInputs(parsed).map((q) => q.header)).toEqual(["Same", "Same (b)"]);
  });
});

describe("buildElicitationContent", () => {
  const parsed = parseElicitationForm(agy)!;

  it("maps a chosen label back to its const", () => {
    expect(buildElicitationContent(parsed, { "Which?": "beta" })).toEqual({ q1: "2" });
  });

  it("routes text outside the options to <key>_other", () => {
    expect(buildElicitationContent(parsed, { "Which?": "gamma" })).toEqual({ q1_other: "gamma" });
  });

  it("omits unanswered fields and unmatched answers without an Other field", () => {
    expect(buildElicitationContent(parsed, {})).toEqual({});
    const closed = parseElicitationForm(form({ s: { type: "string", title: "S", enum: ["a"] } }))!;
    expect(buildElicitationContent(closed, { S: "zzz" })).toEqual({});
  });

  it("maps booleans, multi-select labels and free text", () => {
    const mixed = parseElicitationForm(
      form({
        ok: { type: "boolean", title: "Sure?" },
        tags: {
          type: "array",
          title: "Tags",
          items: {
            anyOf: [
              { const: "a", title: "Alpha" },
              { const: "b", title: "Beta" },
            ],
          },
        },
        note: { type: "string", title: "Note" },
      }),
    )!;
    expect(
      buildElicitationContent(mixed, { "Sure?": "No", Tags: "Alpha, Beta", Note: "hi" }),
    ).toEqual({ ok: false, tags: ["a", "b"], note: "hi" });
  });

  describe("multi-select answers", () => {
    const multi = (withOther: boolean) =>
      parseElicitationForm(
        form({
          t: {
            type: "array",
            title: "T",
            items: {
              anyOf: [
                { const: "x", title: "A, B" },
                { const: "a", title: "A" },
                { const: "b", title: "B" },
              ],
            },
          },
          ...(withOther ? { t_other: { type: "string", title: "Other" } } : {}),
        }),
      )!;

    it("keeps a ticked label that contains a comma as one option", () => {
      expect(buildElicitationContent(multi(false), { T: "A, B" })).toEqual({ t: ["x"] });
      expect(buildElicitationContent(multi(false), { T: "A, B, B" })).toEqual({ t: ["x", "b"] });
    });

    it("keeps ticked options when Other text is added", () => {
      expect(buildElicitationContent(multi(true), { T: "A, B, Teal" })).toEqual({
        t: ["x"],
        t_other: "Teal",
      });
      expect(buildElicitationContent(multi(true), { T: "A, Teal, Navy" })).toEqual({
        t: ["a"],
        t_other: "Teal, Navy",
      });
    });
  });
});
