import { useCallback } from "react";
import { useAppSettings } from "@/hooks/use-settings";

export interface FilePanelAssociations {
  /** Selector key (`ext:md`, `name:Dockerfile`) → panel id, device-wide. */
  associations: Readonly<Record<string, string>>;
  /** Writes the association for a selector key, or forgets it with null. */
  remember(selectorKey: string, panelId: string | null): void;
}

/** The one reader and writer of the device's file panel associations. */
export function useFilePanelAssociations(): FilePanelAssociations {
  const { settings, updateSettings } = useAppSettings();
  const remember = useCallback(
    (selectorKey: string, panelId: string | null) => {
      void updateSettings((current) => ({
        filePanelAssociations: withAssociation(current.filePanelAssociations, selectorKey, panelId),
      }));
    },
    [updateSettings],
  );
  return { associations: settings.filePanelAssociations, remember };
}

function withAssociation(
  associations: Readonly<Record<string, string>>,
  selectorKey: string,
  panelId: string | null,
): Record<string, string> {
  const next = { ...associations };
  if (panelId === null) delete next[selectorKey];
  else next[selectorKey] = panelId;
  return next;
}
