import type { CreateElicitationRequest } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { AcpFormElicitation } from "./elicitation.js";

function formRequest(
  properties: Record<string, unknown>,
  options: {
    message?: string;
    title?: string;
    required?: string[];
    toolCallId?: string;
  } = {},
): CreateElicitationRequest {
  return {
    sessionId: "sess-1",
    mode: "form",
    message: options.message ?? "The agent has a question.",
    ...(options.toolCallId ? { toolCallId: options.toolCallId } : {}),
    requestedSchema: {
      type: "object",
      ...(options.title ? { title: options.title } : {}),
      ...(options.required ? { required: options.required } : {}),
      properties,
    },
  } as CreateElicitationRequest;
}

describe("AcpFormElicitation.parse and respond", () => {
  it("maps agy single-select oneOf + sibling _other (no sentinel) and resolves choices and custom answers", () => {
    const request = formRequest(
      {
        q1: {
          type: "string",
          title: "Pick a color:",
          oneOf: [
            { const: "1", title: "(Recommended) Red" },
            { const: "2", title: "Blue" },
          ],
        },
        q1_other: {
          type: "string",
          title: "Other",
          description: "Optional free-form answer to: Pick a color:",
        },
      },
      { toolCallId: "ask-1" },
    );

    const parsed = AcpFormElicitation.parse(request, { toolName: "ask_question" });
    expect(parsed).not.toBeNull();
    expect(parsed!.request).toEqual({
      name: "ask_question",
      kind: "question",
      title: "Pick a color:",
      description: "The agent has a question.",
      input: {
        questions: [
          {
            id: "q1",
            header: "Question",
            question: "Pick a color:",
            options: [{ label: "(Recommended) Red" }, { label: "Blue" }],
            multiSelect: false,
            allowOther: true,
            allowEmpty: false,
            placeholder: "Optional free-form answer to: Pick a color:",
          },
        ],
      },
    });

    expect(
      parsed!.respond({
        behavior: "allow",
        updatedInput: { answers: { Question: "Blue" } },
      }),
    ).toEqual({ action: "accept", content: { q1: "2" } });

    expect(
      parsed!.respond({
        behavior: "allow",
        updatedInput: { answers: { Question: "Green" } },
      }),
    ).toEqual({ action: "accept", content: { q1_other: "Green" } });

    expect(parsed!.respond({ behavior: "deny" })).toEqual({ action: "decline" });
  });

  it("folds Factory Droid 'other' sentinel option with sibling _other for both single-select and multi-select", () => {
    const request = formRequest(
      {
        question_0: {
          type: "string",
          title: "Approach",
          description: "How should the theme be added?",
          oneOf: [
            { const: "option_0", title: "Extend the palette" },
            { const: "option_1", title: "New theme file" },
            { const: "other", title: "Other answer" },
          ],
        },
        question_0_other: {
          type: "string",
          title: "Approach: Other answer",
          description: "Enter your answer here if you select Other answer.",
        },
        question_1: {
          type: "array",
          title: "Platforms",
          description: "Which platforms should get it?",
          items: {
            anyOf: [
              { const: "option_0", title: "Web" },
              { const: "option_1", title: "iOS" },
              { const: "other", title: "Other answer" },
            ],
          },
          minItems: 1,
        },
        question_1_other: {
          type: "string",
          title: "Platforms: Other answer",
          description: "Enter your answer here if you select Other answer.",
        },
      },
      { message: "Need your input", required: ["question_0", "question_1"] },
    );

    const parsed = AcpFormElicitation.parse(request)!;
    expect(parsed.request.input).toEqual({
      questions: [
        {
          id: "question_0",
          header: "Approach",
          question: "How should the theme be added?",
          options: [{ label: "Extend the palette" }, { label: "New theme file" }],
          multiSelect: false,
          allowOther: true,
          allowEmpty: false,
          placeholder: "Enter your answer here if you select Other answer.",
        },
        {
          id: "question_1",
          header: "Platforms",
          question: "Which platforms should get it?",
          options: [{ label: "Web" }, { label: "iOS" }],
          multiSelect: true,
          allowOther: true,
          allowEmpty: false,
          placeholder: "Enter your answer here if you select Other answer.",
        },
      ],
    });

    // Picking normal options omits _other.
    expect(
      parsed.respond({
        behavior: "allow",
        updatedInput: { answers: { Approach: "New theme file", Platforms: "Web, iOS" } },
      }),
    ).toEqual({
      action: "accept",
      content: { question_0: "option_1", question_1: ["option_0", "option_1"] },
    });

    // Typing custom text includes the "other" sentinel alongside _other.
    expect(
      parsed.respond({
        behavior: "allow",
        updatedInput: {
          answers: { Approach: "Hybrid CSS", Platforms: "Web, Android" },
        },
      }),
    ).toEqual({
      action: "accept",
      content: {
        question_0: "other",
        question_0_other: "Hybrid CSS",
        question_1: ["option_0", "other"],
        question_1_other: "Android",
      },
    });

    // Multi-select custom text alone still sends ["other"] sentinel.
    expect(
      parsed.respond({
        behavior: "allow",
        updatedInput: {
          answers: { Approach: "Extend the palette", Platforms: "Desktop only" },
        },
      }),
    ).toEqual({
      action: "accept",
      content: {
        question_0: "option_0",
        question_1: ["other"],
        question_1_other: "Desktop only",
      },
    });
  });

  it("supports single-select enum and multi-select items.anyOf, items.oneOf, and items.enum", () => {
    const parsed = AcpFormElicitation.parse(
      formRequest({
        size: {
          type: "string",
          title: "Size",
          description: "Choose a size",
          enum: ["S", "M", "L"],
        },
        tagsAny: {
          type: "array",
          title: "Tags",
          description: "Pick tags",
          items: {
            anyOf: [
              { const: "a", title: "Alpha" },
              { const: "b", title: "Beta" },
            ],
          },
        },
        tagsOne: {
          type: "array",
          title: "Scopes",
          description: "Pick scopes",
          items: {
            oneOf: [
              { const: "ui", title: "UI" },
              { const: "api", title: "API" },
            ],
          },
        },
        flags: {
          type: "array",
          title: "Flags",
          description: "Pick flags",
          items: { type: "string", enum: ["fast", "strict"] },
        },
      }),
    )!;

    expect(
      parsed.respond({
        behavior: "allow",
        updatedInput: {
          answers: {
            Size: "M",
            Tags: "Alpha, Beta",
            Scopes: "API",
            Flags: "fast, strict",
          },
        },
      }),
    ).toEqual({
      action: "accept",
      content: {
        size: "M",
        tagsAny: ["a", "b"],
        tagsOne: ["api"],
        flags: ["fast", "strict"],
      },
    });
  });

  it("disambiguates multi-select option labels containing ', ' and preserves ', ' in custom Other answers", () => {
    const parsed = AcpFormElicitation.parse(
      formRequest({
        t: {
          type: "array",
          title: "Pick targets",
          items: {
            anyOf: [
              { const: "ab", title: "A, B" },
              { const: "a", title: "A" },
              { const: "b", title: "B" },
            ],
          },
        },
        t_other: { type: "string", title: "Other" },
      }),
    )!;

    const question = (
      parsed.request.input as { questions: Array<{ options: Array<{ label: string }> }> }
    ).questions[0]!;
    expect(question.options.map((option) => option.label)).toEqual(["A,B", "A", "B"]);

    // Checking "A" and "B" separately cannot be confused with "A, B".
    expect(
      parsed.respond({
        behavior: "allow",
        updatedInput: { answers: { Question: "A, B" } },
      }),
    ).toEqual({ action: "accept", content: { t: ["a", "b"] } });

    // Checking the sanitized "A,B" option alone resolves to "ab".
    expect(
      parsed.respond({
        behavior: "allow",
        updatedInput: { answers: { Question: "A,B" } },
      }),
    ).toEqual({ action: "accept", content: { t: ["ab"] } });

    // Checking "A,B" plus custom Other text containing ", " keeps both intact.
    expect(
      parsed.respond({
        behavior: "allow",
        updatedInput: { answers: { Question: "A,B, Teal, Navy" } },
      }),
    ).toEqual({ action: "accept", content: { t: ["ab"], t_other: "Teal, Navy" } });

    // Custom Other text alone omits empty t array when no sentinel exists.
    expect(
      parsed.respond({
        behavior: "allow",
        updatedInput: { answers: { Question: "Teal, Navy" } },
      }),
    ).toEqual({ action: "accept", content: { t_other: "Teal, Navy" } });
  });

  it("keeps option labels unique when duplicate titles appear", () => {
    const parsed = AcpFormElicitation.parse(
      formRequest({
        plan: {
          type: "string",
          title: "Plan",
          description: "Pick a plan",
          oneOf: [
            { const: "v1", title: "Standard" },
            { const: "v2", title: "Standard" },
            { const: "v2", title: "Standard" },
          ],
        },
      }),
    )!;

    const labels = (
      parsed.request.input as { questions: Array<{ options: Array<{ label: string }> }> }
    ).questions[0]!.options.map((option) => option.label);
    expect(new Set(labels).size).toBe(3);
    expect(labels[0]).toBe("Standard");
    expect(labels[1]).toBe("Standard (v2)");

    expect(
      parsed.respond({
        behavior: "allow",
        updatedInput: { answers: { Plan: labels[1]! } },
      }),
    ).toEqual({ action: "accept", content: { plan: "v2" } });
  });

  it("produces concise unique headers when titles are long, verbatim, or duplicated", () => {
    const longTitle =
      "Which deployment strategy should we use for the upcoming multi-region migration?";
    const parsed = AcpFormElicitation.parse(
      formRequest({
        first: { type: "string", title: longTitle, description: "Choose carefully." },
        second: { type: "string", title: "Scope", description: "First scope" },
        third: { type: "string", title: "Scope", description: "Second scope" },
        fourth: { type: "string", title: "Same text", description: "Same text" },
      }),
    )!;

    const questions = (
      parsed.request.input as {
        questions: Array<{ header: string; question: string }>;
      }
    ).questions;
    expect(questions.map((q) => q.header)).toEqual([
      "Question 1",
      "Scope",
      "Scope (2)",
      "Question 4",
    ]);
    expect(questions[0]!.question).toBe(`${longTitle}\n\nChoose carefully.`);
    expect(questions[3]!.question).toBe("Same text");
  });

  it("marks defaults on single-select, multi-select, boolean, and prefilled text fields", () => {
    const parsed = AcpFormElicitation.parse(
      formRequest({
        env: {
          type: "string",
          title: "Env",
          description: "Target environment",
          default: "prod",
          oneOf: [
            { const: "dev", title: "Dev" },
            { const: "prod", title: "Prod", description: "Live cluster" },
          ],
        },
        regions: {
          type: "array",
          title: "Regions",
          description: "Deploy regions",
          default: ["eu"],
          items: {
            anyOf: [
              { const: "us", title: "US" },
              { const: "eu", title: "EU" },
            ],
          },
        },
        dryRun: {
          type: "boolean",
          title: "Dry run",
          description: "Run without applying changes?",
          default: true,
        },
        tag: {
          type: "string",
          title: "Tag",
          description: "Release tag",
          default: "v1.0.0",
        },
      }),
    )!;

    const questions = (
      parsed.request.input as {
        questions: Array<{
          header: string;
          options: Array<{ label: string; description?: string }>;
          allowOther: boolean;
          allowEmpty: boolean;
        }>;
      }
    ).questions;

    expect(questions[0]!.options).toEqual([
      { label: "Dev" },
      { label: "Prod", description: "Live cluster (Default)" },
    ]);
    expect(questions[1]!.options).toEqual([
      { label: "US" },
      { label: "EU", description: "Default" },
      { label: "None" },
    ]);
    expect(questions[2]!.options).toEqual([
      { label: "Yes", description: "Default" },
      { label: "No" },
    ]);
    expect(questions[3]).toMatchObject({
      options: [{ label: "v1.0.0", description: "Default" }],
      allowOther: true,
      allowEmpty: true,
    });

    // Unanswered prefilled text and boolean fall back to their defaults; explicit answers override.
    expect(
      parsed.respond({
        behavior: "allow",
        updatedInput: {
          answers: {
            Env: "Dev",
            Regions: "None",
            "Dry run": "No",
          },
        },
      }),
    ).toEqual({
      action: "accept",
      content: {
        env: "dev",
        regions: [],
        dryRun: false,
        tag: "v1.0.0",
      },
    });
  });

  it("uses 'No selection' when an optional multi-select without Other already has a 'None' option", () => {
    const parsed = AcpFormElicitation.parse(
      formRequest({
        extras: {
          type: "array",
          title: "Extras",
          description: "Pick extras",
          items: { type: "string", enum: ["None", "Docs"] },
        },
      }),
    )!;

    const options = (
      parsed.request.input as { questions: Array<{ options: Array<{ label: string }> }> }
    ).questions[0]!.options;
    expect(options.map((o) => o.label)).toEqual(["None", "Docs", "No selection"]);

    expect(
      parsed.respond({
        behavior: "allow",
        updatedInput: { answers: { Extras: "No selection" } },
      }),
    ).toEqual({ action: "accept", content: { extras: [] } });

    expect(
      parsed.respond({
        behavior: "allow",
        updatedInput: { answers: { Extras: "None" } },
      }),
    ).toEqual({ action: "accept", content: { extras: ["None"] } });
  });

  it("sets dismissLabel 'Skip' when every field is optional free text, and omits it otherwise", () => {
    const allOptionalText = AcpFormElicitation.parse(
      formRequest({
        note: { type: "string", title: "Note", description: "Any notes?" },
        ref: { type: "string", title: "Ref", description: "Ticket link?" },
      }),
    )!;
    const optionalQuestions = (
      allOptionalText.request.input as {
        questions: Array<{ allowEmpty: boolean; dismissLabel?: string }>;
      }
    ).questions;
    expect(optionalQuestions.every((q) => q.allowEmpty && q.dismissLabel === "Skip")).toBe(true);
    expect(
      allOptionalText.respond({
        behavior: "allow",
        updatedInput: { answers: { Note: "", Ref: "" } },
      }),
    ).toEqual({ action: "accept", content: {} });

    const mixedRequired = AcpFormElicitation.parse(
      formRequest(
        {
          name: { type: "string", title: "Name", description: "Project name" },
          note: { type: "string", title: "Note", description: "Optional note" },
        },
        { required: ["name"] },
      ),
    )!;
    const mixedQuestions = (
      mixedRequired.request.input as {
        questions: Array<{ allowEmpty: boolean; dismissLabel?: string }>;
      }
    ).questions;
    expect(mixedQuestions[0]!.allowEmpty).toBe(false);
    expect(mixedQuestions[1]!.allowEmpty).toBe(true);
    expect(mixedQuestions.some((q) => q.dismissLabel !== undefined)).toBe(false);
  });

  it("keeps __proto__ and Object.prototype keys safe in schema properties and answer maps", () => {
    const properties = Object.fromEntries([
      ["__proto__", { type: "string", title: "__proto__", description: "Proto value" }],
      ["toString", { type: "string", title: "toString", description: "String value" }],
    ]);
    const parsed = AcpFormElicitation.parse(formRequest(properties))!;
    const answers = Object.fromEntries([
      ["__proto__", "safe-proto"],
      ["toString", "safe-string"],
    ]);

    const response = parsed.respond({
      behavior: "allow",
      updatedInput: { answers },
    });
    expect(response.action).toBe("accept");
    const content = (response as { action: "accept"; content: Record<string, unknown> }).content;
    expect(Object.hasOwn(content, "__proto__")).toBe(true);
    expect(content["__proto__"]).toBe("safe-proto");
    expect(content.toString).toBe("safe-string");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("does not absorb a required or non-plain-string sibling _other property", () => {
    const requiredOther = AcpFormElicitation.parse(
      formRequest(
        {
          q1: { type: "string", title: "Q1", enum: ["a", "b"] },
          q1_other: { type: "string", title: "Extra", description: "Always required" },
        },
        { required: ["q1_other"] },
      ),
    )!;
    const questions = (requiredOther.request.input as { questions: Array<{ id: string }> })
      .questions;
    expect(questions.map((q) => q.id)).toEqual(["q1", "q1_other"]);

    // A malformed _other property with an invalid oneOf declines the whole form instead of being absorbed.
    const malformedOther = AcpFormElicitation.parse(
      formRequest({
        q1: { type: "string", title: "Q1", enum: ["a", "b"] },
        q1_other: { type: "string", title: "Other", oneOf: [{ title: "missing-const" }] },
      }),
    );
    expect(malformedOther).toBeNull();

    // A required choice (or minItems > 0 multi-select) without an "other" sentinel keeps
    // <key>_other as a separate optional text field so accepted content always satisfies the schema.
    const requiredPrimaryWithoutSentinel = AcpFormElicitation.parse(
      formRequest(
        {
          q1: { type: "string", title: "Mode", description: "Pick mode", enum: ["fast", "safe"] },
          q1_other: { type: "string", title: "Notes", description: "Optional notes" },
          tags: {
            type: "array",
            title: "Tags",
            description: "Pick at least one",
            minItems: 1,
            items: { type: "string", enum: ["a", "b"] },
          },
          tags_other: { type: "string", title: "Extra tag", description: "Optional extra" },
        },
        { required: ["q1"] },
      ),
    )!;
    const sepQuestions = (
      requiredPrimaryWithoutSentinel.request.input as {
        questions: Array<{ id: string; allowOther: boolean; allowEmpty: boolean }>;
      }
    ).questions;
    expect(sepQuestions.map((q) => [q.id, q.allowOther, q.allowEmpty])).toEqual([
      ["q1", false, false],
      ["q1_other", true, true],
      ["tags", false, false],
      ["tags_other", true, true],
    ]);
    expect(
      requiredPrimaryWithoutSentinel.respond({
        behavior: "allow",
        updatedInput: {
          answers: { Mode: "fast", Notes: "custom", Tags: "a", "Extra tag": "" },
        },
      }),
    ).toEqual({
      action: "accept",
      content: { q1: "fast", q1_other: "custom", tags: ["a"] },
    });
  });

  it.each([
    [
      "url mode",
      {
        sessionId: "sess-1",
        mode: "url",
        elicitationId: "e-1",
        url: "https://example.com/auth",
        message: "Sign in",
      } as CreateElicitationRequest,
    ],
    [
      "unknown mode",
      {
        sessionId: "sess-1",
        mode: "custom",
        message: "Custom",
      } as CreateElicitationRequest,
    ],
    ["empty properties", formRequest({})],
    ["number field", formRequest({ n: { type: "number", title: "Amount" } })],
    ["integer field", formRequest({ count: { type: "integer", title: "Count" } })],
    ["unknown field type", formRequest({ meta: { type: "object" } })],
    ["empty string oneOf", formRequest({ c: { type: "string", oneOf: [] } })],
    [
      "malformed string oneOf (missing const)",
      formRequest({ c: { type: "string", oneOf: [{ title: "Alpha" }] } }),
    ],
    [
      "malformed string oneOf (non-string const)",
      formRequest({ c: { type: "string", oneOf: [{ const: 1, title: "One" }] } }),
    ],
    ["empty string enum", formRequest({ c: { type: "string", enum: [] } })],
    [
      "malformed string enum (non-string entry)",
      formRequest({ c: { type: "string", enum: [1, 2] } }),
    ],
    ["malformed string anyOf", formRequest({ c: { type: "string", anyOf: [{ const: "a" }] } })],
    ["array without items", formRequest({ a: { type: "array" } })],
    ["array with empty anyOf", formRequest({ a: { type: "array", items: { anyOf: [] } } })],
    [
      "array with malformed oneOf",
      formRequest({ a: { type: "array", items: { oneOf: [{ title: "x" }] } } }),
    ],
    ["array with malformed enum", formRequest({ a: { type: "array", items: { enum: [1] } } })],
  ])("returns null for %s", (_name, request) => {
    expect(AcpFormElicitation.parse(request)).toBeNull();
  });

  it("declines cleanly without throwing when a response is missing required fields or has invalid values", () => {
    const requiredClosed = AcpFormElicitation.parse(
      formRequest(
        {
          choice: { type: "string", title: "Choice", description: "Pick one", enum: ["A", "B"] },
          flag: { type: "boolean", title: "Flag", description: "Continue?" },
        },
        { required: ["choice", "flag"] },
      ),
    )!;

    // Missing answers
    expect(requiredClosed.respond({ behavior: "allow" })).toEqual({ action: "decline" });
    // Unmatched option on closed enum
    expect(
      requiredClosed.respond({
        behavior: "allow",
        updatedInput: { answers: { Choice: "Unknown", Flag: "Yes" } },
      }),
    ).toEqual({ action: "decline" });
    // Invalid boolean value
    expect(
      requiredClosed.respond({
        behavior: "allow",
        updatedInput: { answers: { Choice: "A", Flag: "Maybe" } },
      }),
    ).toEqual({ action: "decline" });
    // Non-object updatedInput.answers
    expect(
      requiredClosed.respond({
        behavior: "allow",
        updatedInput: { answers: "bad" as unknown as Record<string, string> },
      }),
    ).toEqual({ action: "decline" });
  });
});
