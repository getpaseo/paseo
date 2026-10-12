import { getDesktopHost } from "@/desktop/host";
import { getDesktopDaemonStatus } from "@/desktop/daemon/desktop-daemon";
import { resolveWorkspaceFilePaths } from "@/workspace/file-open";
import {
  materializeFile,
  openMaterializedFile,
  saveMaterializedFile,
  shareMaterializedFile,
} from "./materialize";
import type { MaterializeInput } from "./types";

export type FileAction = "external" | "choose" | "reveal" | "save" | "share";

export async function performFileAction(
  input: MaterializeInput & { action: FileAction; application?: string; onLocalCopy?(): void },
): Promise<string | null> {
  const bridge = getDesktopHost()?.files;
  let application = input.application;
  if (input.action === "choose") {
    if (!bridge)
      throw new Error("Choosing a desktop application requires the enhanced desktop build.");
    const selected = await bridge.chooseApplication();
    if (!selected) return null;
    application = selected;
  }
  if (
    bridge &&
    (input.action === "external" || input.action === "choose" || input.action === "reveal")
  ) {
    const status = await getDesktopDaemonStatus();
    const local = resolveWorkspaceFilePaths({
      path: input.target.path,
      workspaceRoot: input.target.cwd,
    });
    if (status.serverId === input.target.serverId && local) {
      if (input.action === "reveal") await bridge.reveal(local.absolutePath);
      else await bridge.open({ path: local.absolutePath, application });
      return application ?? null;
    }
  }
  input.onLocalCopy?.();
  const file = await materializeFile(input);
  try {
    if (input.action === "save") await saveMaterializedFile(file);
    else if (input.action === "share") await shareMaterializedFile(file);
    else if (input.action === "reveal") {
      if (!bridge) throw new Error("Finder is only available on the desktop.");
      const bytes = new Uint8Array(await (await fetch(file.uri)).arrayBuffer());
      await bridge.reveal(await bridge.materialize({ name: file.name, bytes }));
    } else await openMaterializedFile(file, application);
    return application ?? null;
  } finally {
    file.release();
  }
}
