import { FileText } from "lucide-react-native";
import invariant from "tiny-invariant";
import { FilePane } from "@/components/file-pane";
import { usePaneContext } from "@/panels/pane-context";
import type { PanelRegistration } from "@/panels/panel-registry";
import { makeDirtyKey, useFileEditorStore } from "@/stores/file-editor-store";

function useFilePanelDescriptor(
  target: { kind: "file"; path: string },
  context: { serverId: string; workspaceId: string },
) {
  const fileName = target.path.split("/").filter(Boolean).pop() ?? target.path;
  const dirtyKey = makeDirtyKey(context.serverId, context.workspaceId, target.path);
  const isDirty = useFileEditorStore((s) => s.dirtyKeys.has(dirtyKey));
  return {
    label: fileName,
    subtitle: target.path,
    titleState: "ready" as const,
    icon: FileText,
    statusBucket: null,
    isDirty,
  };
}

function FilePanel() {
  const { serverId, workspaceId, target } = usePaneContext();
  invariant(target.kind === "file", "FilePanel requires file target");
  return <FilePane serverId={serverId} workspaceRoot={workspaceId} filePath={target.path} />;
}

export const filePanelRegistration: PanelRegistration<"file"> = {
  kind: "file",
  component: FilePanel,
  useDescriptor: useFilePanelDescriptor,
};
