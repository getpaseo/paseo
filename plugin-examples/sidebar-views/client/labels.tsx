import { useMutation } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import {
  usePaseo,
  useSettings,
  useWorkspaces,
  type WorkspaceRef,
  type PluginSidebarViewProps,
} from "@getpaseo/plugin/client";
import { folders } from "../shared/preferences";
import { Heading, WorkspaceRow } from "./rows";
interface Move {
  reference: WorkspaceRef;
  from: string | null;
}
function folderLabel(key: string): string | null {
  return key === "unlabelled" ? null : key.slice("label:".length);
}
function Movable({
  reference,
  folder,
  view,
  select,
}: {
  reference: WorkspaceRef;
  folder: string | null;
  view: PluginSidebarViewProps;
  select: (move: Move) => void;
}) {
  const pick = useCallback(() => select({ reference, from: folder }), [select, reference, folder]);
  return (
    <View>
      <WorkspaceRow reference={reference} view={view} onLongPress={pick} />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Move workspace ${reference.id}`}
        onPress={pick}
      >
        <Heading title="Move…" view={view} />
      </Pressable>
    </View>
  );
}
export function Labels(view: PluginSidebarViewProps) {
  const paseo = usePaseo();
  const settings = useSettings(folders);
  const [selected, select] = useState<Move | null>(null);
  const groups = useWorkspaces({
    orderBy: "name",
    groupBy: (item) =>
      item.labels.length ? item.labels.map((label) => `label:${label}`) : ["unlabelled"],
  });
  const style = useMemo(
    () => ({ color: view.theme.colors.foreground, paddingHorizontal: 12 }),
    [view.theme],
  );
  const move = useMutation({
    mutationFn: async (destination: string | null) => {
      if (!selected) return;
      const workspace = paseo.workspaces.ref(selected.reference);
      // Add first: if adding fails the workspace keeps its original folder.
      if (destination && destination !== selected.from)
        await workspace.setLabel(destination, { assigned: true });
      if (selected.from && selected.from !== destination)
        await workspace.setLabel(selected.from, { assigned: false });
      select(null);
    },
  });
  const toggle = useCallback(
    (folder: string) => {
      if (settings.status !== "ready") return;
      void settings.save(
        {
          collapsed: settings.values.collapsed.includes(folder)
            ? settings.values.collapsed.filter((item) => item !== folder)
            : [...settings.values.collapsed, folder],
        },
        settings.revision,
      );
    },
    [settings],
  );
  const cancel = useCallback(() => select(null), []);
  if (settings.status === "loading") return <Text style={style}>Loading folders…</Text>;
  if (settings.status !== "ready")
    return (
      <View>
        <Text style={style}>{settings.error}</Text>
        <Pressable accessibilityRole="button" onPress={settings.reload}>
          <Heading title="Reload folders" view={view} />
        </Pressable>
        {settings.status === "invalid" ? (
          <Pressable accessibilityRole="button" onPress={settings.reset}>
            <Heading title="Reset folders" view={view} />
          </Pressable>
        ) : null}
      </View>
    );
  return (
    <ScrollView>
      {selected ? (
        <View>
          <Text style={style}>Choose a destination folder</Text>
          <Pressable accessibilityRole="button" onPress={cancel}>
            <Heading title="Cancel move" view={view} />
          </Pressable>
        </View>
      ) : (
        <Text style={style}>Long press a workspace or choose Move…</Text>
      )}
      {move.error ? <Text style={style}>{move.error.message}</Text> : null}
      {Array.from(
        new Set(["label:Inbox", "label:Later", "unlabelled", ...groups.map((group) => group.key)]),
      ).map((folder) => (
        <Folder
          key={folder}
          folder={folder}
          view={view}
          selected={!!selected}
          pending={move.isPending}
          move={move.mutate}
          collapsed={settings.values.collapsed.includes(folder)}
          toggle={toggle}
        >
          {groups
            .find((group) => group.key === folder)
            ?.items.map((reference) => (
              <Movable
                key={reference.key}
                reference={reference}
                folder={folderLabel(folder)}
                view={view}
                select={select}
              />
            ))}
        </Folder>
      ))}
      {settings.saveError ? <Text style={style}>{settings.saveError}</Text> : null}
    </ScrollView>
  );
}
function Folder({
  folder,
  view,
  selected,
  pending,
  move,
  collapsed,
  toggle,
  children,
}: {
  folder: string;
  view: PluginSidebarViewProps;
  selected: boolean;
  pending: boolean;
  move: (folder: string | null) => void;
  collapsed: boolean;
  toggle: (folder: string) => void;
  children: import("react").ReactNode;
}) {
  const toggleFolder = useCallback(() => toggle(folder), [toggle, folder]);
  const label = folderLabel(folder);
  const title = label ?? "Unlabelled";
  const destination = useCallback(() => move(label), [move, label]);
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Toggle ${title}`}
        onPress={toggleFolder}
      >
        <Heading title={`${collapsed ? "▸" : "▾"} ${title}`} view={view} />
      </Pressable>
      {selected ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label === null ? "Remove current label" : `Move to ${title}`}
          disabled={pending}
          onPress={destination}
        >
          <Heading
            title={label === null ? "Remove current label" : `Move to ${title}`}
            view={view}
          />
        </Pressable>
      ) : null}
      {collapsed ? null : children}
    </View>
  );
}
