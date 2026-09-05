export interface RememberTerminalCloseChoiceInput {
  /** Writes the preference. Rejects when the underlying storage write fails. */
  persist: () => Promise<void>;
  /** Called with the rejection so the caller can keep the failure visible to the user. */
  onFailure: (error: unknown) => void;
}

/**
 * Stores the user's "don't ask again" answer from the terminal close dialog.
 *
 * The settings cache is updated before the storage write, so a rejected write leaves the app
 * behaving as if the preference stuck while nothing was saved. Swallowing that would hand the
 * user a setting that silently reverts on restart, so the failure is reported instead. Closing
 * the terminal is what the user actually asked for and still goes ahead either way.
 */
export async function rememberTerminalCloseChoice(
  input: RememberTerminalCloseChoiceInput,
): Promise<boolean> {
  try {
    await input.persist();
    return true;
  } catch (error) {
    input.onFailure(error);
    return false;
  }
}
