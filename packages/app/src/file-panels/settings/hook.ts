import { useCallback, useMemo } from "react";
import { useFilePanelAssociations } from "../associations";
import { useAllHostsFilePanels, type FilePanel } from "../panels";
import { buildFilePanelSettingsRows, type FilePanelSettingsRow } from "./rows";

export interface FilePanelSettings {
  rows: readonly FilePanelSettingsRow<FilePanel>[];
  /** Remembers `panelId` for the key; the next open of a matching file uses it. */
  choose(selectorKey: string, panelId: string): void;
  /** Forgets the key's panel, so the next open of a matching file asks. */
  askAgain(selectorKey: string): void;
}

/** Settings > Files: the keys worth configuring across every host, and the commands on them. */
export function useFilePanelSettings(): FilePanelSettings {
  const candidates = useAllHostsFilePanels();
  const { associations, remember } = useFilePanelAssociations();
  const rows = useMemo(
    () => buildFilePanelSettingsRows({ candidates, associations }),
    [associations, candidates],
  );
  const askAgain = useCallback((selectorKey: string) => remember(selectorKey, null), [remember]);
  return { rows, choose: remember, askAgain };
}
