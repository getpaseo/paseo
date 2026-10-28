import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { type PluginWorkspacePanelProps, useRpc, useWorkspace } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSection,
  SettingsRow,
  ScrollView,
} from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listVariables, saveVariable, removeVariable } from "../shared/environment";
import { EnvironmentEditor } from "./editor";

export function EnvironmentPanel(props: PluginWorkspacePanelProps) {
  return <WorkspaceEnvironment key={props.workspaceId} {...props} />;
}

interface VariableRowProps {
  name: string;
  description: string;
  pending: boolean;
  confirming: boolean;
  editor: EnvironmentEditor;
}

function VariableRow({ name, description, pending, confirming, editor }: VariableRowProps) {
  const replace = useCallback(() => editor.replace(name, description), [editor, name, description]);
  const remove = useCallback(() => {
    void editor.remove(name);
  }, [editor, name]);
  const confirm = useCallback(() => editor.confirmRemove(name), [editor, name]);
  const cancel = useCallback(() => editor.confirmRemove(null), [editor]);
  return (
    <SettingsCard>
      <SettingsRow label={name} hint={description || "Value saved"} />
      <SettingsAction
        label="Replace value"
        actionLabel="Replace"
        disabled={pending}
        onPress={replace}
      />
      {confirming ? (
        <>
          <SettingsAction
            label={`Remove ${name}?`}
            hint="The saved value will be deleted."
            actionLabel="Confirm remove"
            disabled={pending}
            onPress={remove}
          />
          <SettingsAction
            label="Keep variable"
            actionLabel="Cancel"
            disabled={pending}
            onPress={cancel}
          />
        </>
      ) : (
        <SettingsAction
          label="Remove variable"
          actionLabel="Remove"
          disabled={pending}
          onPress={confirm}
        />
      )}
    </SettingsCard>
  );
}

function WorkspaceEnvironment({ theme, layout, workspaceId }: PluginWorkspacePanelProps) {
  const project = useWorkspace(workspaceId, (workspace) => workspace.projectDisplayName);
  const list = useRpc(listVariables);
  const save = useRpc(saveVariable);
  const remove = useRpc(removeVariable);
  const queryClient = useQueryClient();
  const variables = useQuery({
    queryKey: ["project-environment", workspaceId],
    queryFn: () => list({ workspaceId }),
  });
  const [editor] = useState(
    () =>
      new EnvironmentEditor({
        async save(variable) {
          // Mutation caches retain submitted arguments, including secrets. Use a direct event RPC.
          await save({ workspaceId, variable });
          await queryClient.invalidateQueries({ queryKey: ["project-environment"] });
        },
        async remove(name) {
          await remove({ workspaceId, name });
          await queryClient.invalidateQueries({ queryKey: ["project-environment"] });
        },
      }),
  );
  const form = useSyncExternalStore(editor.subscribe, editor.getState);
  const pending = form.status === "pending";
  const styles = useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      content: { padding: layout.compact ? 16 : 24, gap: 24 },
      introduction: { gap: 8 },
      title: { color: theme.colors.foreground, fontWeight: "600" as const },
      detail: { color: theme.colors.foregroundMuted },
      error: { color: theme.colors.statusDanger },
    }),
    [theme, layout.compact],
  );
  const { refetch } = variables;
  const retry = useCallback(() => {
    void refetch();
  }, [refetch]);
  const setName = useCallback((text: string) => editor.set("name", text), [editor]);
  const setDescription = useCallback((text: string) => editor.set("description", text), [editor]);
  const setValue = useCallback((text: string) => editor.set("value", text), [editor]);
  const submit = useCallback(() => {
    void editor.save();
  }, [editor]);
  const messageStyle = form.status === "error" ? styles.error : styles.detail;
  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.introduction}>
        <Text style={styles.title}>Project environment</Text>
        <Text style={styles.detail}>
          Shared across {project ?? "this project"} and its worktrees. Changes apply to the next
          environment command.
        </Text>
        <Text style={styles.detail}>
          Values are stored on this host and hidden after saving. Commands using a variable can
          access it and call APIs with it.
        </Text>
      </View>
      <SettingsSection title="Saved variables">
        {variables.isPending ? <Text style={styles.detail}>Loading…</Text> : null}
        {variables.isError ? (
          <SettingsAction label="Could not load variables" actionLabel="Retry" onPress={retry} />
        ) : null}
        {variables.data?.variables.length === 0 ? (
          <Text style={styles.detail}>No variables yet.</Text>
        ) : null}
        {variables.data?.variables.map((variable) => (
          <VariableRow
            key={variable.name}
            name={variable.name}
            description={variable.description}
            pending={pending}
            confirming={form.removing === variable.name}
            editor={editor}
          />
        ))}
      </SettingsSection>
      <SettingsSection title="Add or replace a variable">
        <SettingsCard key={form.revision}>
          <SettingsInput
            label="Name"
            initialValue={form.name}
            placeholder="STRIPE_API_KEY"
            disabled={pending}
            onChangeText={setName}
          />
          <SettingsInput
            label="Description"
            initialValue={form.description}
            placeholder="Development key for Stripe API calls"
            disabled={pending}
            onChangeText={setDescription}
          />
          <SettingsInput
            label="Value"
            hint="Only the name and description are shown to the agent."
            secureTextEntry
            disabled={pending}
            onChangeText={setValue}
          />
          <SettingsAction
            label="Save variable"
            hint="An existing variable with the same name will be replaced."
            actionLabel={pending ? "Saving…" : "Save"}
            disabled={pending || !variables.isSuccess}
            onPress={submit}
          />
        </SettingsCard>
        {form.message ? (
          <Text accessibilityRole="alert" style={messageStyle}>
            {form.message}
          </Text>
        ) : null}
      </SettingsSection>
      <Text style={styles.detail}>
        Agents created after installation get the environment tools automatically. Ask the agent to
        list project environment variables and use its environment command tool for API calls. Its
        regular shell and running servers keep their existing environment.
      </Text>
    </ScrollView>
  );
}
