import { useCallback } from "react";
import { copyText, SidebarRow } from "@getpaseo/plugin/client/ui";
import type {
  PluginButtonRegistration,
  PluginClientContext,
  PluginSidebarItemProps,
} from "@getpaseo/plugin/client";
import { messages } from "./client/messages";
import { Notes } from "./client/notes";

function NotesItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  const open = useCallback(() => openScreen({ screenId: "notes" }), [openScreen]);
  return (
    <SidebarRow icon="NotebookPen" active={currentScreen?.screenId === "notes"} onPress={open} />
  );
}
export default function contribute(client: PluginClientContext) {
  let tools: PluginButtonRegistration | undefined;
  client.addScreen({ id: "notes", title: messages.message("title"), Component: Notes });
  client.addSidebarHeaderItem({
    id: "notes",
    title: messages.message("title"),
    Component: NotesItem,
  });
  client.addWorkspacePanel({
    id: "notes",
    title: messages.message("title"),
    icon: "NotebookPen",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: Notes,
  });
  client.addSettingsScreen({
    id: "notes",
    title: messages.message("title"),
    icon: "NotebookPen",
    Component: Notes,
  });
  client.addCommandCenterItem({
    id: "notes",
    title: messages.message("open"),
    icon: "NotebookPen",
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: "notes" });
    },
  });
  client.addSlashCommand({
    name: "notes",
    description: messages.message("description"),
    argumentHint: messages.message("hint"),
    context: "workspace",
    onSubmit({ openScreen }) {
      openScreen({ screenId: "notes" });
    },
  });
  client.addCommandCenterItem({
    id: "copy-title",
    title: messages.message("copyTitle"),
    icon: "Copy",
    context: "global",
    onSelect() {
      return copyText(client.i18n.t(messages, "title"));
    },
  });
  client.addCommandCenterItem({
    id: "tools",
    title: messages.message("pin"),
    icon: "NotebookPen",
    context: "workspace",
    onSelect({ workspace, openPanel }) {
      tools?.remove();
      tools = client.addHeaderButton({
        id: "notes-tools",
        workspaceId: workspace.id,
        button: {
          title: messages.message("tools"),
          icon: "NotebookPen",
          behavior: {
            kind: "menu",
            items: [
              {
                kind: "item",
                id: "open",
                title: messages.message("openPanel"),
                behavior: {
                  kind: "action",
                  onPress() {
                    openPanel("notes");
                  },
                },
              },
            ],
          },
        },
      });
    },
  });
  return () => tools?.remove();
}
