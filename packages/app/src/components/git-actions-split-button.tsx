import { useCallback } from "react";
import { View, Text, ActivityIndicator, Pressable } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { ChevronDown, Info, MoreVertical } from "lucide-react-native";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Shortcut } from "@/components/ui/shortcut";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import { useToast } from "@/contexts/toast-context";
import type { GitAction, GitActions } from "@/components/git-actions-policy";

interface GitActionsSplitButtonProps {
  gitActions: GitActions;
  hideLabels?: boolean;
}

export function GitActionsSplitButton({ gitActions, hideLabels }: GitActionsSplitButtonProps) {
  const { theme } = useUnistyles();
  const toast = useToast();
  const archiveShortcutKeys = useShortcutKeys("archive-worktree");

  const getActionDisplayLabel = useCallback((action: GitAction): string => {
    if (action.status === "pending") return action.pendingLabel;
    if (action.status === "success") return action.successLabel;
    return action.label;
  }, []);

  const handleActionSelect = useCallback(
    (action: GitAction) => {
      if (action.unavailableMessage) {
        toast.show(action.unavailableMessage, {
          durationMs: 3200,
          icon: <Info size={16} color={theme.colors.foreground} />,
        });
        return;
      }
      action.handler();
    },
    [theme.colors.foreground, toast],
  );

  return (
    <View style={styles.row}>
      {gitActions.primary ? (
        <View style={styles.splitButton}>
          <Pressable
            testID="changes-primary-cta"
            style={({ hovered, pressed }) => [
              styles.splitButtonPrimary,
              (hovered || pressed) && styles.splitButtonPrimaryHovered,
              gitActions.primary!.disabled && styles.splitButtonPrimaryDisabled,
            ]}
            onPress={gitActions.primary.handler}
            disabled={gitActions.primary.disabled}
            accessibilityRole="button"
            accessibilityLabel={gitActions.primary.label}
          >
            {gitActions.primary.status === "pending" ? (
              <ActivityIndicator
                size="small"
                color={theme.colors.foreground}
                style={styles.splitButtonSpinnerOnly}
              />
            ) : (
              <View style={styles.splitButtonContent}>
                {gitActions.primary.icon}
                {!hideLabels && (
                  <Text style={styles.splitButtonText}>
                    {getActionDisplayLabel(gitActions.primary)}
                  </Text>
                )}
              </View>
            )}
          </Pressable>
          {gitActions.secondary.length > 0 ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                testID="changes-primary-cta-caret"
                style={({ hovered, pressed, open }) => [
                  styles.splitButtonCaret,
                  (hovered || pressed || open) && styles.splitButtonCaretHovered,
                ]}
                accessibilityRole="button"
                accessibilityLabel="More options"
              >
                <ChevronDown size={16} color={theme.colors.foregroundMuted} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" testID="changes-primary-cta-menu">
                {gitActions.secondary.map((action, index) => {
                  const needsSeparator =
                    action.id === "merge-from-base" || action.id === "archive-worktree";
                  return (
                    <View key={action.id}>
                      {needsSeparator && index > 0 ? <DropdownMenuSeparator /> : null}
                      <DropdownMenuItem
                        testID={`changes-menu-${action.id}`}
                        leading={action.icon}
                        trailing={
                          action.id === "archive-worktree" && archiveShortcutKeys ? (
                            <Shortcut chord={archiveShortcutKeys} />
                          ) : undefined
                        }
                        disabled={action.disabled}
                        muted={Boolean(action.unavailableMessage)}
                        status={action.status}
                        pendingLabel={action.pendingLabel}
                        successLabel={action.successLabel}
                        closeOnSelect={
                          action.status === "idle" &&
                          action.id === "pr" &&
                          action.label === "View PR"
                        }
                        onSelect={() => handleActionSelect(action)}
                      >
                        {action.label}
                      </DropdownMenuItem>
                    </View>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </View>
      ) : null}
      {gitActions.menu.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            testID="changes-overflow-menu"
            hitSlop={8}
            style={[styles.iconButton, styles.overflowMenuButton]}
            accessibilityRole="button"
            accessibilityLabel="More actions"
          >
            <MoreVertical size={16} color={theme.colors.foregroundMuted} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" width={220} testID="changes-overflow-content">
            {gitActions.menu.map((action) => (
              <DropdownMenuItem
                key={action.id}
                testID={`changes-menu-${action.id}`}
                leading={action.icon}
                disabled={action.disabled}
                muted={Boolean(action.unavailableMessage)}
                status={action.status}
                pendingLabel={action.pendingLabel}
                successLabel={action.successLabel}
                closeOnSelect={false}
                onSelect={() => handleActionSelect(action)}
              >
                {action.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexShrink: 0,
  },
  splitButton: {
    flexDirection: "row",
    alignItems: "stretch",
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    overflow: "hidden",
  },
  splitButtonPrimary: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    justifyContent: "center",
    position: "relative",
  },
  splitButtonPrimaryHovered: {
    backgroundColor: theme.colors.surface2,
  },
  splitButtonPrimaryDisabled: {
    opacity: 0.6,
  },
  splitButtonText: {
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.5,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.normal,
  },
  splitButtonContent: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
  },
  splitButtonSpinnerOnly: {
    transform: [{ scale: 0.8 }],
  },
  splitButtonCaret: {
    width: 28,
    alignItems: "center",
    justifyContent: "center",
    borderLeftWidth: theme.borderWidth[1],
    borderLeftColor: theme.colors.borderAccent,
  },
  splitButtonCaretHovered: {
    backgroundColor: theme.colors.surface2,
  },
  iconButton: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
  },
  overflowMenuButton: {
    marginRight: -theme.spacing[2],
  },
}));
