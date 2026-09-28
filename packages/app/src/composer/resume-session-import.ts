import type {
  DaemonClient,
  FetchRecentProviderSessionEntry,
} from "@getpaseo/client/internal/daemon-client";
import { getSessionTitle } from "@/components/import-session-sheet-view-model";

type ResumeImportClient = Pick<
  DaemonClient,
  "createWorkspace" | "importAgent" | "archiveWorkspace"
>;

/** Give each resumed terminal session a sidebar workspace of its own. */
export async function importResumeSession(
  client: ResumeImportClient,
  entry: FetchRecentProviderSessionEntry,
): Promise<Awaited<ReturnType<DaemonClient["importAgent"]>>> {
  if (!entry.cwd) throw new Error("Session is missing a working directory");

  const created = await client.createWorkspace({
    source: { kind: "directory", path: entry.cwd },
    title: getSessionTitle(entry),
  });
  if (!created.workspace || created.error) {
    throw new Error(created.error ?? "Could not create a workspace for the session");
  }

  try {
    return await client.importAgent({
      providerId: entry.providerId,
      providerHandleId: entry.providerHandleId,
      cwd: entry.cwd,
      workspaceId: created.workspace.id,
    });
  } catch (error) {
    try {
      const archived = await client.archiveWorkspace(created.workspace.id);
      if (archived.error)
        console.error("Could not archive failed resume workspace", archived.error);
    } catch (archiveError) {
      console.error("Could not archive failed resume workspace", archiveError);
    }
    throw error;
  }
}
