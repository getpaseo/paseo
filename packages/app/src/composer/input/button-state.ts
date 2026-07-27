export type ComposerPrimaryButtonMode = "stop" | "queue" | "send";

export interface ComposerPrimaryButtonState {
  mode: ComposerPrimaryButtonMode;
  disabled: boolean;
}

export function resolveComposerPrimaryButtonState(input: {
  disabled: boolean;
  isSubmitDisabled: boolean;
  isSubmitLoading: boolean;
  canSubmitContent: boolean;
  isAgentRunning: boolean;
  canStop: boolean;
  canQueue: boolean;
}): ComposerPrimaryButtonState {
  if (input.isAgentRunning && input.canStop && !input.canSubmitContent) {
    return { mode: "stop", disabled: input.disabled };
  }

  const mode = input.isAgentRunning && input.canQueue ? "queue" : "send";
  return {
    mode,
    disabled:
      input.disabled || input.isSubmitDisabled || input.isSubmitLoading || !input.canSubmitContent,
  };
}

export function runComposerPrimaryButtonAction(
  mode: ComposerPrimaryButtonMode,
  actions: { stop: () => void; queue: () => void; send: () => void },
): void {
  if (mode === "stop") {
    actions.stop();
    return;
  }
  if (mode === "queue") {
    actions.queue();
    return;
  }
  actions.send();
}
