import type { PluginTheme } from "@getpaseo/plugin";
import { useCallback, useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import { describeRequest } from "./detail-text";
import { ActionButton } from "./question-card";
import type { PermissionRequest, PermissionResponse } from "./types";

interface PermissionControlsProps {
  request: PermissionRequest;
  theme: PluginTheme;
  disabled: boolean;
  onRespond(response: PermissionResponse): void;
}

type PermissionAction = NonNullable<PermissionRequest["actions"]>[number];

function defaultActions(request: PermissionRequest): PermissionAction[] {
  return [
    { id: "reject", label: "Deny", behavior: "deny", variant: "danger" },
    {
      id: "accept",
      label: request.kind === "plan" ? "Implement" : "Allow",
      behavior: "allow",
      variant: "primary",
    },
  ];
}

function PermissionActionButton({
  action,
  theme,
  disabled,
  onRespond,
}: {
  action: PermissionAction;
  theme: PluginTheme;
  disabled: boolean;
  onRespond(response: PermissionResponse): void;
}) {
  const handlePress = useCallback(() => {
    onRespond(
      action.behavior === "allow"
        ? { behavior: "allow", selectedActionId: action.id }
        : { behavior: "deny", selectedActionId: action.id, message: "Denied from Inbox" },
    );
  }, [action.behavior, action.id, onRespond]);
  return (
    <ActionButton
      theme={theme}
      label={action.label}
      primary={action.variant === "primary"}
      danger={action.variant === "danger"}
      disabled={disabled}
      onPress={handlePress}
    />
  );
}

export function PermissionControls({
  request,
  theme,
  disabled,
  onRespond,
}: PermissionControlsProps) {
  const styles = useMemo(
    () =>
      StyleSheet.create({
        container: { gap: 8 },
        title: { color: theme.colors.foreground, fontSize: 14, lineHeight: 20 },
        description: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 16 },
        row: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
      }),
    [theme],
  );
  const actions =
    request.actions && request.actions.length > 0 ? request.actions : defaultActions(request);
  const text = describeRequest(request);
  return (
    <View style={styles.container}>
      <Text style={styles.title}>{text.headline}</Text>
      {text.preview ? (
        <Text numberOfLines={3} style={styles.description}>
          {text.preview}
        </Text>
      ) : null}
      <View style={styles.row}>
        {actions.map((action) => (
          <PermissionActionButton
            key={action.id}
            action={action}
            theme={theme}
            disabled={disabled}
            onRespond={onRespond}
          />
        ))}
      </View>
    </View>
  );
}
