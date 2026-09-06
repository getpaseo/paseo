import { describe, expect, it } from "vitest";
import {
  DEFAULT_ASSISTANT_CONFIGURATION,
  type AssistantTemplate,
} from "@getpaseo/protocol/assistants";
import { openAssistantForm, type AssistantFormSnapshot } from "./assistant-form-model";

const TEMPLATE_ID = "tpl_" + "a".repeat(32);
const OTHER_TEMPLATE_ID = "tpl_" + "b".repeat(32);
const ASSISTANT_ID = "ast_" + "c".repeat(32);

const template: AssistantTemplate = {
  id: TEMPLATE_ID,
  name: "Chief of staff",
  configuration: {
    instructions: "Route work, never code.",
    context: "Working on the voice project.",
    voice: "cedar",
    backendModel: "gpt-5",
    backendThinkingOptionId: "high",
  },
  revision: 1,
  createdAt: "2026-09-06T00:00:00.000Z",
  updatedAt: "2026-09-06T00:00:00.000Z",
};

const otherTemplate: AssistantTemplate = {
  ...template,
  id: OTHER_TEMPLATE_ID,
  name: "Reviewer",
  configuration: { ...DEFAULT_ASSISTANT_CONFIGURATION, instructions: "Only review." },
};

function snapshot(overrides: Partial<AssistantFormSnapshot> = {}): AssistantFormSnapshot {
  return {
    kind: "assistant",
    mode: "create",
    templates: [template, otherTemplate],
    voiceOptions: ["cedar", "marin"],
    backendModelOptions: [
      { id: "gpt-5", label: "GPT-5", thinkingOptionIds: ["low", "high"] },
      { id: "gpt-5-mini", label: "GPT-5 mini", thinkingOptionIds: ["low"] },
    ],
    ...overrides,
  };
}

describe("assistant form model", () => {
  it("starts from a template by copying its configuration once", () => {
    const model = openAssistantForm(snapshot());
    model.setName("Ada");
    model.setTemplate(TEMPLATE_ID);
    expect(model.getState().configuration).toEqual(template.configuration);

    model.setInstructions("Route work, and summarise first.");
    expect(model.buildCreateAssistantInput()).toEqual({
      name: "Ada",
      templateId: TEMPLATE_ID,
      configuration: {
        ...template.configuration,
        instructions: "Route work, and summarise first.",
      },
    });
    // The template itself is untouched: the copy is the form's own state.
    expect(template.configuration.instructions).toBe("Route work, never code.");
  });

  it("copies again when another template is chosen and resets on none", () => {
    const model = openAssistantForm(snapshot());
    model.setTemplate(TEMPLATE_ID);
    model.setContext("edited");
    model.setTemplate(OTHER_TEMPLATE_ID);
    expect(model.getState().configuration).toEqual(otherTemplate.configuration);
    expect(model.getState().templateId).toBe(OTHER_TEMPLATE_ID);

    model.setTemplate(null);
    expect(model.getState().configuration).toEqual(DEFAULT_ASSISTANT_CONFIGURATION);
    expect(model.getState().templateId).toBeNull();
  });

  it("does not let templates seed an edit or a template form", () => {
    const edit = openAssistantForm(
      snapshot({
        mode: "edit",
        record: {
          id: ASSISTANT_ID,
          name: "Ada",
          revision: 4,
          configuration: { ...DEFAULT_ASSISTANT_CONFIGURATION, instructions: "keep" },
        },
      }),
    );
    edit.setTemplate(TEMPLATE_ID);
    expect(edit.getState().configuration.instructions).toBe("keep");
    expect(edit.buildUpdateAssistantInput()).toMatchObject({
      assistantId: ASSISTANT_ID,
      expectedRevision: 4,
      name: "Ada",
    });

    const templateForm = openAssistantForm(snapshot({ kind: "template" }));
    templateForm.setTemplate(TEMPLATE_ID);
    expect(templateForm.getState().configuration).toEqual(DEFAULT_ASSISTANT_CONFIGURATION);
  });

  it("requires a name and bounds the long fields", () => {
    const model = openAssistantForm(snapshot());
    expect(model.getState().canSubmit).toBe(false);
    expect(model.getState().nameError).toBe("name_required");

    model.setName("  Ada  ");
    expect(model.getState().canSubmit).toBe(true);
    expect(model.buildCreateAssistantInput().name).toBe("Ada");

    model.setInstructions("x".repeat(1001));
    expect(model.getState().canSubmit).toBe(false);
    expect(model.getState().nameError).toBe("too_long");

    model.setInstructions("x".repeat(1000));
    expect(model.getState().canSubmit).toBe(true);
    model.setName("n".repeat(121));
    expect(model.getState().nameError).toBe("name_too_long");
  });

  it("drops a thinking choice the new backend model does not offer", () => {
    const model = openAssistantForm(snapshot());
    model.setBackendModel("gpt-5");
    model.setBackendThinking("high");
    expect(model.getState().availableThinkingOptionIds).toEqual(["low", "high"]);

    model.setBackendModel("gpt-5-mini");
    expect(model.getState().configuration.backendThinkingOptionId).toBeNull();
    expect(model.getState().availableThinkingOptionIds).toEqual(["low"]);

    model.setBackendModel(null);
    expect(model.getState().availableThinkingOptionIds).toEqual([]);
  });

  it("seeds a template form from an assistant without carrying its identity", () => {
    const model = openAssistantForm(
      snapshot({
        kind: "template",
        seed: { name: "Ada", configuration: template.configuration },
      }),
    );
    expect(model.getState().name).toBe("Ada");
    expect(model.buildSaveTemplateInput()).toEqual({
      name: "Ada",
      configuration: template.configuration,
    });
  });

  it("normalizes blank optional values to null on submit", () => {
    const model = openAssistantForm(snapshot());
    model.setName("Ada");
    model.setVoice("  ");
    model.setBackendModel(" ");
    model.setContext("  notes  ");
    expect(model.buildCreateAssistantInput().configuration).toEqual({
      ...DEFAULT_ASSISTANT_CONFIGURATION,
      context: "notes",
    });
  });
});
