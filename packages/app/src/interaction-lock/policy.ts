export interface ComposerInteractionPolicy {
  canEdit: boolean;
  canSend: boolean;
  canQueue: boolean;
  canChangeControls: boolean;
  canStartVoice: boolean;
  canRespondToPermissions: boolean;
  canMutateAgent: boolean;
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
  };
}
