import type { CreateElicitationRequest } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { buildElicitationResponse, parseFormElicitation } from "./elicitation.js";

describe("ACP form elicitation mapping", () => {
  it("maps single-select oneOf with paired _other write-in to a question permission and resolves selected and custom answers", () => {
    const request: CreateElicitationRequest = {
      mode: "form",
      sessionId: "sess-1",
      toolCallId: "call-1",
      message: "The agent has a question.",
      requestedSchema: {
        type: "object",
        properties: {
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
      },
    };

    const parsed = parseFormElicitation(request, "ask_question");
    expect(parsed?.request).toEqual({
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
      buildElicitationResponse(parsed!, {
        behavior: "allow",
        updatedInput: { answers: { Question: "Blue" } },
      }),
    ).toEqual({ action: "accept", content: { q1: "2" } });

    expect(
      buildElicitationResponse(parsed!, {
        behavior: "allow",
        updatedInput: { answers: { Question: "Green" } },
      }),
    ).toEqual({ action: "accept", content: { q1_other: "Green" } });

    expect(buildElicitationResponse(parsed!, { behavior: "deny" })).toEqual({
      action: "decline",
    });
  });

  it("maps multi-select arrays with paired _other write-in, preserving commas in option labels", () => {
    const request: CreateElicitationRequest = {
      mode: "form",
      sessionId: "sess-1",
      message: "Select targets",
      requestedSchema: {
        type: "object",
        properties: {
          targets: {
            type: "array",
            title: "Which platforms?",
            items: {
              anyOf: [
                { const: "mobile", title: "iOS, Android" },
                { const: "web", title: "Web" },
              ],
            },
          },
          targets_other: {
            type: "string",
            title: "Other",
          },
        },
      },
    };

    const parsed = parseFormElicitation(request);
    expect(parsed?.request.input).toEqual({
      questions: [
        {
          id: "targets",
          header: "Question",
          question: "Which platforms?",
          options: [{ label: "iOS, Android" }, { label: "Web" }],
          multiSelect: true,
          allowOther: true,
          allowEmpty: false,
        },
      ],
    });

    expect(
      buildElicitationResponse(parsed!, {
        behavior: "allow",
        updatedInput: { answers: { Question: "iOS, Android, Web, Desktop" } },
      }),
    ).toEqual({
      action: "accept",
      content: { targets: ["mobile", "web"], targets_other: "Desktop" },
    });
  });

  it("maps text, boolean, integer, and multi-question forms and rejects non-form elicitations", () => {
    const request: CreateElicitationRequest = {
      mode: "form",
      sessionId: "sess-1",
      message: "Configure release",
      requestedSchema: {
        type: "object",
        title: "Release settings",
        required: ["tag"],
        properties: {
          tag: { type: "string", title: "Tag", description: "Release version tag" },
          dryRun: { type: "boolean", title: "Dry run", description: "Skip publishing?" },
          retries: { type: "integer", title: "Retries", description: "Max retry attempts" },
        },
      },
    };

    const parsed = parseFormElicitation(request);
    expect(parsed?.request.title).toBe("Release settings");
    expect(
      buildElicitationResponse(parsed!, {
        behavior: "allow",
        updatedInput: {
          answers: {
            Tag: "v1.2.3",
            "Dry run": "Yes",
            Retries: "3",
          },
        },
      }),
    ).toEqual({
      action: "accept",
      content: { tag: "v1.2.3", dryRun: true, retries: 3 },
    });

    expect(
      parseFormElicitation({
        mode: "url",
        sessionId: "sess-1",
        elicitationId: "e-1",
        url: "https://example.com/auth",
        message: "Open browser",
      }),
    ).toBeNull();
  });
});
