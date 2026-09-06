import {
  DEFAULT_ASSISTANT_CONFIGURATION,
  type AssistantConfiguration,
  type AssistantTemplate,
} from "@getpaseo/protocol/assistants";

/**
 * Bounds mirror the wire schema. The daemon rejects longer values, so the form
 * stops the user first rather than failing on submit.
 */
export const ASSISTANT_NAME_MAX_LENGTH = 120;
export const ASSISTANT_INSTRUCTIONS_MAX_LENGTH = 1000;
export const ASSISTANT_CONTEXT_MAX_LENGTH = 8000;

export type AssistantFormKind = "assistant" | "template";
export type AssistantFormMode = "create" | "edit";

export interface AssistantFormRecord {
  id: string;
  name: string;
  configuration: AssistantConfiguration;
  revision: number;
}

export interface AssistantFormBackendModelOption {
  id: string;
  label: string;
  thinkingOptionIds: string[];
}

export interface AssistantFormSnapshot {
  kind: AssistantFormKind;
  mode: AssistantFormMode;
  /** The record being edited. Required in edit mode. */
  record?: AssistantFormRecord;
  /** Templates a new assistant can start from. Ignored for templates. */
  templates: readonly AssistantTemplate[];
  /** Pre-filled values for create mode, e.g. "save as template" from an assistant. */
  seed?: { name?: string; configuration?: AssistantConfiguration; templateId?: string | null };
  voiceOptions: readonly string[];
  backendModelOptions: readonly AssistantFormBackendModelOption[];
}

export type AssistantFormError = "name_required" | "name_too_long" | "too_long";

export interface AssistantFormState {
  kind: AssistantFormKind;
  mode: AssistantFormMode;
  name: string;
  /** Provenance only: the template whose configuration was copied at creation. */
  templateId: string | null;
  configuration: AssistantConfiguration;
  templates: AssistantTemplate[];
  voiceOptions: string[];
  backendModelOptions: AssistantFormBackendModelOption[];
  /** Thinking ids the chosen backend model supports; empty without a model. */
  availableThinkingOptionIds: string[];
  nameError: AssistantFormError | null;
  canSubmit: boolean;
  submitError: string | null;
}

export interface AssistantFormModel {
  getState: () => AssistantFormState;
  subscribe: (listener: () => void) => () => void;
  close: () => void;
  applyTemplates: (templates: readonly AssistantTemplate[]) => void;
  applyVoiceOptions: (voices: readonly string[]) => void;
  applyBackendModelOptions: (options: readonly AssistantFormBackendModelOption[]) => void;
  setName: (value: string) => void;
  /**
   * Copies the template's configuration into the form. A later edit does not
   * track the template, and choosing another template copies again over
   * whatever was typed; templates are starting points, not links.
   */
  setTemplate: (templateId: string | null) => void;
  setInstructions: (value: string) => void;
  setContext: (value: string) => void;
  setVoice: (voice: string | null) => void;
  setBackendModel: (model: string | null) => void;
  setBackendThinking: (thinkingOptionId: string | null) => void;
  setSubmitError: (value: string | null) => void;
  buildCreateAssistantInput: () => {
    name: string;
    templateId?: string;
    configuration: AssistantConfiguration;
  };
  buildUpdateAssistantInput: () => {
    assistantId: string;
    expectedRevision: number;
    name: string;
    configuration: AssistantConfiguration;
  };
  buildSaveTemplateInput: () => {
    templateId?: string;
    expectedRevision?: number;
    name: string;
    configuration: AssistantConfiguration;
  };
}

function cloneConfiguration(configuration: AssistantConfiguration): AssistantConfiguration {
  return {
    instructions: configuration.instructions,
    context: configuration.context,
    voice: configuration.voice,
    backendModel: configuration.backendModel,
    backendThinkingOptionId: configuration.backendThinkingOptionId,
  };
}

function normalizeConfiguration(configuration: AssistantConfiguration): AssistantConfiguration {
  return {
    instructions: configuration.instructions.trim(),
    context: configuration.context.trim(),
    voice: configuration.voice?.trim() || null,
    backendModel: configuration.backendModel?.trim() || null,
    backendThinkingOptionId: configuration.backendThinkingOptionId?.trim() || null,
  };
}

function resolveNameError(name: string): AssistantFormError | null {
  const trimmed = name.trim();
  if (!trimmed) {
    return "name_required";
  }
  if (trimmed.length > ASSISTANT_NAME_MAX_LENGTH) {
    return "name_too_long";
  }
  return null;
}

function resolveThinkingOptionIds(
  options: readonly AssistantFormBackendModelOption[],
  backendModel: string | null,
): string[] {
  if (!backendModel) {
    return [];
  }
  return options.find((option) => option.id === backendModel)?.thinkingOptionIds ?? [];
}

export function openAssistantForm(snapshot: AssistantFormSnapshot): AssistantFormModel {
  const listeners = new Set<() => void>();
  let closed = false;

  const initialConfiguration =
    snapshot.mode === "edit" && snapshot.record
      ? snapshot.record.configuration
      : (snapshot.seed?.configuration ?? DEFAULT_ASSISTANT_CONFIGURATION);
  const initialName =
    snapshot.mode === "edit" && snapshot.record
      ? snapshot.record.name
      : (snapshot.seed?.name ?? "");

  let state: AssistantFormState = derive({
    kind: snapshot.kind,
    mode: snapshot.mode,
    name: initialName,
    templateId: snapshot.seed?.templateId ?? null,
    configuration: cloneConfiguration(initialConfiguration),
    templates: [...snapshot.templates],
    voiceOptions: [...snapshot.voiceOptions],
    backendModelOptions: [...snapshot.backendModelOptions],
    availableThinkingOptionIds: [],
    nameError: null,
    canSubmit: false,
    submitError: null,
  });

  function derive(next: AssistantFormState): AssistantFormState {
    const nameError = resolveNameError(next.name);
    const availableThinkingOptionIds = resolveThinkingOptionIds(
      next.backendModelOptions,
      next.configuration.backendModel,
    );
    const tooLong =
      next.configuration.instructions.length > ASSISTANT_INSTRUCTIONS_MAX_LENGTH ||
      next.configuration.context.length > ASSISTANT_CONTEXT_MAX_LENGTH;
    return {
      ...next,
      availableThinkingOptionIds,
      nameError: nameError ?? (tooLong ? "too_long" : null),
      canSubmit: nameError === null && !tooLong,
    };
  }

  function publish(next: AssistantFormState): void {
    if (closed) {
      return;
    }
    state = derive(next);
    for (const listener of listeners) {
      listener();
    }
  }

  function patchConfiguration(patch: Partial<AssistantConfiguration>): void {
    publish({ ...state, configuration: { ...state.configuration, ...patch } });
  }

  function requireRecord(): AssistantFormRecord {
    if (!snapshot.record) {
      throw new Error("Assistant form has no record to update");
    }
    return snapshot.record;
  }

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close: () => {
      closed = true;
      listeners.clear();
    },
    applyTemplates: (templates) => {
      publish({ ...state, templates: [...templates] });
    },
    applyVoiceOptions: (voices) => {
      publish({ ...state, voiceOptions: [...voices] });
    },
    applyBackendModelOptions: (options) => {
      publish({ ...state, backendModelOptions: [...options] });
    },
    setName: (value) => {
      publish({ ...state, name: value });
    },
    setTemplate: (templateId) => {
      if (state.kind !== "assistant" || state.mode !== "create") {
        return;
      }
      if (templateId === null) {
        publish({
          ...state,
          templateId: null,
          configuration: cloneConfiguration(DEFAULT_ASSISTANT_CONFIGURATION),
        });
        return;
      }
      const template = state.templates.find((candidate) => candidate.id === templateId);
      if (!template) {
        return;
      }
      publish({
        ...state,
        templateId,
        configuration: cloneConfiguration(template.configuration),
      });
    },
    setInstructions: (value) => {
      patchConfiguration({ instructions: value });
    },
    setContext: (value) => {
      patchConfiguration({ context: value });
    },
    setVoice: (voice) => {
      patchConfiguration({ voice });
    },
    setBackendModel: (model) => {
      // The thinking pick belongs to a model; a different model starts from its default.
      const thinkingStillValid =
        model !== null &&
        state.configuration.backendThinkingOptionId !== null &&
        resolveThinkingOptionIds(state.backendModelOptions, model).includes(
          state.configuration.backendThinkingOptionId,
        );
      patchConfiguration({
        backendModel: model,
        backendThinkingOptionId: thinkingStillValid
          ? state.configuration.backendThinkingOptionId
          : null,
      });
    },
    setBackendThinking: (thinkingOptionId) => {
      patchConfiguration({ backendThinkingOptionId: thinkingOptionId });
    },
    setSubmitError: (value) => {
      publish({ ...state, submitError: value });
    },
    buildCreateAssistantInput: () => ({
      name: state.name.trim(),
      ...(state.templateId ? { templateId: state.templateId } : {}),
      configuration: normalizeConfiguration(state.configuration),
    }),
    buildUpdateAssistantInput: () => {
      const record = requireRecord();
      return {
        assistantId: record.id,
        expectedRevision: record.revision,
        name: state.name.trim(),
        configuration: normalizeConfiguration(state.configuration),
      };
    },
    buildSaveTemplateInput: () => {
      const record = state.mode === "edit" ? requireRecord() : null;
      return {
        ...(record ? { templateId: record.id, expectedRevision: record.revision } : {}),
        name: state.name.trim(),
        configuration: normalizeConfiguration(state.configuration),
      };
    },
  };
}
