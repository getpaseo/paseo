import { useMemo, type ReactElement, type ReactNode } from "react";
import { type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { MoreVertical, type LucideIcon } from "lucide-react-native";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedMoreVertical = withUnistyles(MoreVertical);

/** A single action rendered inside a {@link FileActionsMenu}. */
export interface FileAction {
  key: string;
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
  testID?: string;
}

interface FileActionsMenuProps {
  /** Ordered actions. The menu renders nothing when this is empty. */
  actions: FileAction[];
  /** Optional metadata block rendered above the actions (e.g. size/modified). */
  header?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  hitSlop?: number;
  accessibilityLabel: string;
  testID?: string;
}

// The menu lives inside pressable rows (diff header, explorer entry); stop the
// press so opening it doesn't also trigger the row.
function stopTriggerPropagation(event: { stopPropagation?: () => void }) {
  event.stopPropagation?.();
}

function triggerStyle({
  hovered,
  pressed,
  open,
}: PressableStateCallbackType & { hovered?: boolean; open?: boolean }) {
  return [styles.trigger, (Boolean(hovered) || pressed || Boolean(open)) && styles.triggerActive];
}

/**
 * Shared kebab (⋮) menu for per-file actions. Used by the file explorer tree and
 * the git diff pane so both surfaces expose the same actions with identical
 * chrome. Callers build the {@link FileAction} list; this owns the trigger and
 * menu layout.
 */
export function FileActionsMenu({
  actions,
  header,
  open,
  onOpenChange,
  hitSlop = 12,
  accessibilityLabel,
  testID,
}: FileActionsMenuProps): ReactElement | null {
  if (actions.length === 0) {
    return null;
  }
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger
        hitSlop={hitSlop}
        onPressIn={stopTriggerPropagation}
        style={triggerStyle}
        accessibilityLabel={accessibilityLabel}
        testID={testID}
      >
        <ThemedMoreVertical size={ICON_SIZE.sm} uniProps={foregroundMutedColorMapping} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" width={220}>
        {header ? (
          <>
            {header}
            <DropdownMenuSeparator />
          </>
        ) : null}
        {actions.map((action) => (
          <FileActionMenuItem key={action.key} action={action} />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function FileActionMenuItem({ action }: { action: FileAction }): ReactElement {
  const Icon = action.icon;
  const ThemedIcon = useMemo(() => withUnistyles(Icon), [Icon]);
  const leading = useMemo(
    () => <ThemedIcon size={ICON_SIZE.sm} uniProps={foregroundMutedColorMapping} />,
    [ThemedIcon],
  );
  return (
    <DropdownMenuItem leading={leading} onSelect={action.onSelect} testID={action.testID}>
      {action.label}
    </DropdownMenuItem>
  );
}

const styles = StyleSheet.create((theme) => ({
  trigger: {
    // The hover box comes from padding, but an equal negative vertical margin
    // cancels its height contribution so the trigger overlaps the row's natural
    // line height instead of growing it. The comfortable tap target is `hitSlop`,
    // never padding.
    padding: theme.spacing[1],
    marginVertical: -theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  triggerActive: {
    backgroundColor: theme.colors.surface2,
  },
}));
