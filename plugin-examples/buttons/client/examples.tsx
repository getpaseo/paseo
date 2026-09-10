import {
  type PluginButton,
  type PluginButtonContentProps,
  type PluginButtonIconProps,
  type PluginClientContext,
  useWorkspace,
} from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";

export type ButtonMode = "action" | "menu" | "popover";

const composerPresentation = {
  action: { title: "Refresh context", label: "Refresh" },
  menu: { title: "Composer tools", label: "Tools" },
  popover: { title: "Context details", label: "Details" },
};

function WorkspaceStatusIcon({ workspaceId, size, color, theme }: PluginButtonIconProps) {
  const status = useWorkspace(workspaceId, (workspace) => workspace.status);
  let fill = color;
  if (status === "failed") fill = theme.colors.statusDanger;
  else if (status === "needs_input") fill = theme.colors.statusWarning;
  else if (status === "done") fill = theme.colors.statusSuccess;
  const style = useMemo(
    () => ({ width: size, height: size, borderRadius: size / 2, backgroundColor: fill }),
    [size, fill],
  );
  return <View style={style} />;
}

function WorkspaceDetails({ workspaceId, theme, close }: PluginButtonContentProps) {
  const workspace = useWorkspace(workspaceId, ({ name, projectDisplayName, status, diffStat }) => ({
    name,
    projectDisplayName,
    status,
    diffStat,
  }));
  const styles = useMemo(
    () => ({
      body: { gap: 12 },
      title: { color: theme.colors.foreground, fontSize: 18 },
      text: { color: theme.colors.foreground },
      detail: { color: theme.colors.foregroundMuted },
      button: { padding: 8, borderRadius: 6, backgroundColor: theme.colors.surface2 },
    }),
    [theme],
  );
  return (
    <View style={styles.body}>
      <Text style={styles.title}>Workspace details</Text>
      <Text style={styles.text}>{workspace?.name}</Text>
      <Text style={styles.detail}>{workspace?.projectDisplayName}</Text>
      <Text style={styles.detail}>Status: {workspace?.status}</Text>
      {workspace?.diffStat ? (
        <Text style={styles.detail}>
          +{workspace.diffStat.additions} / −{workspace.diffStat.deletions} lines
        </Text>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close workspace details"
        onPress={close}
        style={styles.button}
      >
        <Text style={styles.text}>Done</Text>
      </Pressable>
    </View>
  );
}

export function createButtonExamples(
  client: PluginClientContext,
  workspaceId: string,
  agentId: string,
) {
  let mode: ButtonMode = "action";
  let refreshes = 0;

  async function refreshWorkspace() {
    // Return the real operation's promise: Paseo supplies pending, double-press prevention, and errors.
    await client.paseo.workspaces.ref(workspaceId).refresh();
    refreshes += 1;
    if (mode === "action") {
      header.update({ title: `Refresh workspace (${refreshes})` });
      pill.update({ label: `Refreshed · ${refreshes}` });
    }
  }

  function button(next: ButtonMode): PluginButton {
    if (next === "action")
      return {
        title: "Refresh workspace",
        icon: "RefreshCw",
        label: undefined, // The header is icon-only. The composer supplies its own label below.
        behavior: { kind: "action", onPress: refreshWorkspace },
      };
    if (next === "popover")
      return {
        title: "Workspace details",
        icon: WorkspaceStatusIcon,
        label: "Details",
        behavior: { kind: "popover", Content: WorkspaceDetails },
      };
    return {
      title: "Workspace tools",
      icon: "Wrench",
      label: "Tools",
      behavior: {
        kind: "menu",
        items: [
          {
            kind: "item",
            id: "refresh",
            title: "Refresh workspace",
            icon: "RefreshCw",
            behavior: { kind: "action", onPress: refreshWorkspace },
          },
          { kind: "separator", id: "details-divider" },
          {
            kind: "item",
            id: "details",
            title: "Workspace details",
            icon: WorkspaceStatusIcon,
            behavior: { kind: "popover", Content: WorkspaceDetails },
          },
          {
            kind: "item",
            id: "display",
            title: "Display",
            icon: "Eye",
            behavior: {
              kind: "menu",
              items: [
                {
                  kind: "item",
                  id: "hide",
                  title: "Hide example buttons",
                  icon: "EyeOff",
                  behavior: {
                    kind: "action",
                    onPress() {
                      setVisible(false);
                    },
                  },
                },
                {
                  kind: "item",
                  id: "disable",
                  title: "Disable example buttons",
                  behavior: {
                    kind: "action",
                    onPress() {
                      setDisabled(true);
                    },
                  },
                },
              ],
            },
          },
          {
            kind: "item",
            id: "publish",
            title: "Publish (unavailable in example)",
            icon: "Upload",
            disabled: true,
            behavior: { kind: "action", onPress() {} },
          },
        ],
      },
    };
  }

  function composerButton(next: ButtonMode): PluginButton {
    return {
      ...button(next),
      ...composerPresentation[next],
    };
  }

  const header = client.addHeaderButton({ id: "example", workspaceId, button: button(mode) });
  const pill = client.addComposerPill({
    id: "example",
    workspaceId,
    agentId,
    button: composerButton(mode),
  });

  function setVisible(visible: boolean) {
    header.update({ visible });
    pill.update({ visible });
  }
  function setDisabled(disabled: boolean) {
    header.update({ disabled });
    pill.update({ disabled });
  }
  return {
    setMode(next: ButtonMode) {
      mode = next;
      header.update({ ...button(next), visible: true, disabled: false });
      pill.update({ ...composerButton(next), visible: true, disabled: false });
    },
    setVisible,
    setDisabled,
    remove() {
      header.remove();
      pill.remove();
    },
  };
}
