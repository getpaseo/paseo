import { useCallback } from "react";
import type {
  DaemonClient,
  FetchRecentProviderSessionEntry,
} from "@getpaseo/client/internal/daemon-client";
import { ImportSessionSheet } from "@/components/import-session-sheet";
import { useNavigateToImportedAgent } from "@/hooks/use-import-session";
import { importResumeSession } from "@/composer/resume-session-import";

export function ResumeSessionSheet({
  client,
  serverId,
  preferredProviderId,
  onClose,
}: {
  client: DaemonClient | null;
  serverId: string;
  preferredProviderId?: string;
  onClose: () => void;
}) {
  const navigateToImportedAgent = useNavigateToImportedAgent(serverId);
  const importSession = useCallback(
    (entry: FetchRecentProviderSessionEntry) => {
      if (!client) throw new Error("Host is disconnected");
      return importResumeSession(client, entry);
    },
    [client],
  );
  return (
    <ImportSessionSheet
      visible
      client={client}
      serverId={serverId}
      preferredProviderId={preferredProviderId}
      importSession={importSession}
      onClose={onClose}
      onImported={navigateToImportedAgent}
    />
  );
}
