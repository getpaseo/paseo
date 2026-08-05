export interface ComposerInteractionPolicy {
  canEdit: boolean;
  canSend: boolean;
  canQueue: boolean;
  canChangeControls: boolean;
  canStartVoice: boolean;
  canRespondToPermissions: boolean;
  canMutateAgent: boolean;
  /** Switch agents/workspaces, open settings, command center navigation. */
  canNavigate: boolean;
}

export function resolveComposerInteractionPolicy(input: {
  locked: boolean;
}): ComposerInteractionPolicy {
  if (!input.locked) {
    return {
      canEdit: true,
      canSend: true,
      canQueue: true,
      canChangeControls: true,
      canStartVoice: true,
      canRespondToPermissions: true,
      canMutateAgent: true,
      canNavigate: true,
    };
  }
  return {
    canEdit: false,
    canSend: false,
    canQueue: false,
    canChangeControls: false,
    canStartVoice: false,
    canRespondToPermissions: false,
    canMutateAgent: false,
    canNavigate: false,
  };
}
