/**
 * Whether the composer's model/mode values were explicitly chosen by the user
 * (or seeded from an explicit source such as an existing agent's setup). An
 * "implicit" selection must be omitted from the create-agent request so the
 * provider's own configured default applies instead of a Paseo-resolved one.
 */
export type DraftSelectionSource = "explicit" | "implicit";

export interface DraftSelectionSourceFlags {
  model: DraftSelectionSource;
  modeId: DraftSelectionSource;
  thinkingOptionId: DraftSelectionSource;
}

export function resolveDraftSelectionSource(input: {
  userModified?: { model?: boolean; modeId?: boolean; thinkingOptionId?: boolean } | null;
  initialValues?: {
    model?: string | null;
    modeId?: string | null;
    thinkingOptionId?: string | null;
  } | null;
  /** Saved per-provider preferences; a remembered selection is explicit too. */
  savedSelection?: {
    model?: string | null;
    modeId?: string | null;
    thinkingOptionId?: string | null;
  } | null;
}): DraftSelectionSourceFlags {
  const userModified = input.userModified ?? {};
  const initialValues = input.initialValues ?? {};
  const savedSelection = input.savedSelection ?? {};
  const hasSavedModel = Boolean(savedSelection.model?.trim());
  const hasSavedMode = Boolean(savedSelection.mode?.trim());
  const hasSavedThinking = Boolean(savedSelection.thinkingOptionId?.trim());
  return {
    model:
      (userModified.model ?? false) || hasSavedModel || Boolean(initialValues.model?.trim())
        ? "explicit"
        : "implicit",
    modeId:
      (userModified.modeId ?? false) || hasSavedMode || Boolean(initialValues.modeId?.trim())
        ? "explicit"
        : "implicit",
    thinkingOptionId:
      (userModified.thinkingOptionId ?? false) ||
      hasSavedThinking ||
      Boolean(initialValues.thinkingOptionId?.trim())
        ? "explicit"
        : "implicit",
  };
}
