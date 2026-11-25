/** The Markdown library dispatches menu presses by label, so one title can have only one owner. */
export function dedupeAssistantSelectionActions<Action extends { title: string }>(
  actions: readonly Action[],
  onCollision: (action: Action) => void,
): Action[] {
  const titles = new Set<string>();
  return actions.filter((action) => {
    if (titles.has(action.title)) {
      onCollision(action);
      return false;
    }
    titles.add(action.title);
    return true;
  });
}

export interface AssistantSelectionMenuAction {
  title: string;
  run(selection: { text: string; messageId: string }): Promise<void>;
}

export interface AssistantSelectionMenuItem {
  text: string;
  onPress(event: { text: string }): void;
}

/**
 * Menu items for one assistant message. iOS only: Android's selection toolbar is unverified.
 * Finished messages only: a press does not reliably arrive while text streams, and the selection
 * is dropped when the stream completes.
 */
export function buildAssistantSelectionMenuItems<
  Action extends AssistantSelectionMenuAction,
>(input: {
  platform: string;
  finished: boolean;
  messageId: string | undefined;
  actions: readonly Action[] | undefined;
  onError(action: Action, error: unknown): void;
}): AssistantSelectionMenuItem[] | undefined {
  const { actions, finished, messageId, onError, platform } = input;
  if (platform !== "ios" || !finished || !messageId || !actions?.length) return undefined;
  return actions.map((action) => ({
    text: action.title,
    onPress: ({ text }) => runAssistantSelectionAction(action, { text, messageId }, onError),
  }));
}

function runAssistantSelectionAction<Action extends AssistantSelectionMenuAction>(
  action: Action,
  selection: { text: string; messageId: string },
  onError: (action: Action, error: unknown) => void,
): void {
  try {
    void action.run(selection).catch((error: unknown) => onError(action, error));
  } catch (error) {
    onError(action, error);
  }
}
