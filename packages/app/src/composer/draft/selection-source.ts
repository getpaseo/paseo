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
  const resolveFlag = (
    userTouched: boolean | undefined,
    saved: string | null | undefined,
    initial: string | null | undefined,
  ): DraftSelectionSource =>
    (userTouched ?? false) || Boolean(saved?.trim()) || Boolean(initial?.trim())
      ? "explicit"
      : "implicit";
  return {
    model: resolveFlag(userModified.model, savedSelection.model, initialValues.model),
    modeId: resolveFlag(userModified.modeId, savedSelection.modeId, initialValues.modeId),
    thinkingOptionId: resolveFlag(
      userModified.thinkingOptionId,
      savedSelection.thinkingOptionId,
      initialValues.thinkingOptionId,
    ),
  };
}
