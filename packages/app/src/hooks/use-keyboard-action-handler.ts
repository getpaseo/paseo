import { useEffect } from "react";

import {
  keyboardActionDispatcher,
  type KeyboardActionDefinition,
  type KeyboardActionHandler,
  type KeyboardActionId,
} from "@/keyboard/keyboard-action-dispatcher";

type UseKeyboardActionHandlerInput = {
  handlerId: string;
  actions: readonly KeyboardActionId[];
  enabled: boolean;
  priority: number;
  isActive?: () => boolean;
  handle: (action: KeyboardActionDefinition) => boolean;
};

export function useKeyboardActionHandler(input: UseKeyboardActionHandlerInput) {
  useEffect(() => {
    return keyboardActionDispatcher.registerHandler({
      handlerId: input.handlerId,
      actions: input.actions,
      enabled: input.enabled,
      priority: input.priority,
      isActive: input.isActive,
      handle: input.handle,
    });
  }, [input.actions, input.enabled, input.handle, input.handlerId, input.isActive, input.priority]);
}
