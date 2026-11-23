import { useId } from "react";
import { hasFocusedTextInput } from "@/keyboard";
import type { KeyboardActionId } from "@/keyboard/keyboard-action-dispatcher";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";

export interface KeyboardToggleAction {
  id: KeyboardActionId;
  canOpen: () => boolean;
}

/** Lets a trigger share its toggle with a keyboard action. */
export function useKeyboardToggle({
  action,
  disabled,
  open,
  searchFocused,
  onToggle,
}: {
  action: KeyboardToggleAction | undefined;
  disabled: boolean;
  open: boolean;
  searchFocused: boolean;
  onToggle: () => void;
}) {
  const handlerId = useId();
  useKeyboardActionHandler({
    handlerId,
    actions: action ? [action.id] : [],
    enabled: action !== undefined && !disabled,
    priority: 200,
    isActive: () =>
      action?.canOpen() === true || (open && (searchFocused || !hasFocusedTextInput())),
    handle: () => {
      onToggle();
      return true;
    },
  });
}
