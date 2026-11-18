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
  /**
   * The provider's pinned default model (provider settings pin, resolved from
   * preferences or the daemon config via the provider snapshot). A remembered
   * last-used model only counts as explicit when it matches the pin or no pin
   * exists; otherwise the pin wins and the model is omitted so the server
   * resolves the pinned default.
   */
  providerDefaultModel?: string | null;
}): DraftSelectionSourceFlags {
  const userModified = input.userModified ?? {};
  const initialValues = input.initialValues ?? {};
  const savedSelection = input.savedSelection ?? {};
  const providerDefaultModel = input.providerDefaultModel?.trim() || null;
  const resolveFlag = (
    userTouched: boolean | undefined,
    saved: string | null | undefined,
    initial: string | null | undefined,
  ): DraftSelectionSource => {
    if ((userTouched ?? false) || Boolean(initial?.trim())) {
      return "explicit";
    }
    return saved?.trim() ? "explicit" : "implicit";
  };
  // The model flag is pin-aware: a remembered last-used model only counts as
  // explicit when it matches the pinned default or no pin exists; otherwise
  // the pin wins and the model is omitted so the server resolves the pinned
  // default. Mode and thinking have no pin, so they keep the plain rule.
  const resolveModelFlag = (
    userTouched: boolean | undefined,
    saved: string | null | undefined,
    initial: string | null | undefined,
  ): DraftSelectionSource => {
    if ((userTouched ?? false) || Boolean(initial?.trim())) {
      return "explicit";
    }
    const savedValue = saved?.trim();
    if (!savedValue) {
      return "implicit";
    }
    if (!providerDefaultModel || savedValue === providerDefaultModel) {
      return "explicit";
    }
    return "implicit";
  };
  return {
    model: resolveModelFlag(userModified.model, savedSelection.model, initialValues.model),
    modeId: resolveFlag(userModified.modeId, savedSelection.modeId, initialValues.modeId),
    thinkingOptionId: resolveFlag(
      userModified.thinkingOptionId,
      savedSelection.thinkingOptionId,
      initialValues.thinkingOptionId,
    ),
  };
}
