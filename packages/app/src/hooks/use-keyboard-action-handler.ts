import { useEffect, useRef } from "react";

import {
  keyboardActionDispatcher,
  type KeyboardActionDefinition,
  type KeyboardActionId,
} from "@/keyboard/keyboard-action-dispatcher";

interface UseKeyboardActionHandlerInput {
  handlerId: string;
  actions: readonly KeyboardActionId[];
  enabled: boolean;
  priority: number;
  isActive?: () => boolean;
  handle: (action: KeyboardActionDefinition) => boolean;
}

/**
 * Registers a keyboard action handler with the global dispatcher.
 *
 * The dispatcher is driven by a native window keydown listener and calls the
 * most-recently-registered matching handler first (see keyboard-action-dispatcher.ts).
 * Two properties must hold or handlers bound to the same action step on each other:
 *
 *  1. Stable registration order. registerHandler bumps a registration counter, so
 *     re-registering on every render reshuffles which handler the dispatcher reaches
 *     first. A frequently re-rendering control (e.g. a running agent's mode control)
 *     would then jump ahead of another (e.g. the New Workspace draft) and consume the
 *     key, silently acting on the wrong surface. So we register once per
 *     (handlerId, priority, actions) and never re-register just because handle,
 *     isActive, or enabled changed.
 *
 *  2. Fresh callbacks. Because we do not re-register on every render, the registered
 *     entry must read the latest props at dispatch time. handle and isActive are read
 *     live from a ref, and enabled is folded into isActive so the dispatcher
 *     re-evaluates it fresh (the plain enabled field it filters on is captured at
 *     registration and would otherwise go stale).
 */
export function useKeyboardActionHandler(input: UseKeyboardActionHandlerInput) {
  const inputRef = useRef(input);
  inputRef.current = input;

  // Only these identity-affecting fields trigger a re-register. actions is compared by
  // content, not array identity, so inline literals do not churn the registration.
  const actionsKey = input.actions.join(" ");
  useEffect(() => {
    return keyboardActionDispatcher.registerHandler({
      handlerId: inputRef.current.handlerId,
      actions: inputRef.current.actions,
      // Always-on at the coarse filter; the real enable/active gate is re-checked fresh
      // inside isActive below so it can never be stale in the registry entry.
      enabled: true,
      priority: inputRef.current.priority,
      isActive: () => {
        const current = inputRef.current;
        if (!current.enabled) return false;
        return current.isActive ? current.isActive() : true;
      },
      handle: (action) => inputRef.current.handle(action),
    });
  }, [input.handlerId, input.priority, actionsKey]);
}
