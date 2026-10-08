import { useEffect, useRef, useSyncExternalStore } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Field, FormTextInput } from "@/components/ui/form-field";
import type { EditingTextInputHandle } from "@/components/ui/text-input";
import type { WorktreeFormModel } from "./worktree-form-model";

/** Shared native/web fields dispatch edits to the model, preserving manually entered names. */
export function WorktreeFields({
  model,
  compact,
  disabled,
  visible,
}: {
  model: WorktreeFormModel;
  compact: boolean;
  disabled: boolean;
  visible: boolean;
}) {
  const state = useSyncExternalStore(model.subscribe, model.getState);
  const nameInput = useRef<EditingTextInputHandle>(null);
  useEffect(() => {
    // User edits already live in the editor; only replace reactive defaults.
    if (nameInput.current?.getText() !== state.worktreeName) {
      nameInput.current?.replaceText(state.worktreeName);
    }
  }, [state.worktreeName]);
  if (!visible) return null;
  const size = compact ? "md" : "sm";
  return (
    <View style={styles.fields}>
      <Field label="Worktree name">
        <FormTextInput
          ref={nameInput}
          initialValue={state.worktreeName}
          onChangeText={model.setWorktreeName}
          size={size}
          editable={!disabled}
          autoCapitalize="none"
          accessibilityLabel="Worktree name"
          testID="new-workspace-worktree-name"
        />
      </Field>
      {state.mode === "branch-off" ? (
        <Field label="New branch name">
          <FormTextInput
            initialValue={state.branchName}
            onChangeText={model.setBranchName}
            size={size}
            editable={!disabled}
            autoCapitalize="none"
            accessibilityLabel="New branch name"
            testID="new-workspace-branch-name"
          />
        </Field>
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  fields: {
    gap: theme.spacing[2],
    marginBottom: theme.spacing[4],
    paddingHorizontal: theme.spacing[6],
  },
}));
