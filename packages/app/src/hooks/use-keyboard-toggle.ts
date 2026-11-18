import { useId } from "react";
import { hasActiveOverlay } from "@/keyboard";
import type { KeyboardActionId } from "@/keyboard/keyboard-action-dispatcher";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";

/** Lets a trigger share its toggle with a keyboard action. */
export function useKeyboardToggle({
  action,
  disabled,
  open,
  onToggle,
}: {
  action: KeyboardActionId | undefined;
  disabled: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const handlerId = useId();
  useKeyboardActionHandler({
    handlerId,
    actions: action ? [action] : [],
    enabled: action !== undefined && !disabled,
    priority: 200,
    isActive: () => open || !hasActiveOverlay(),
    handle: () => {
      onToggle();
      return true;
    },
  });
}
