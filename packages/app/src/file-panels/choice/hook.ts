import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { usePaneContext } from "@/panels/pane-context";
import type { PanelInstanceIdentity } from "@/panels/panel-instance-attributes";
import { useFilePanelAssociations } from "../associations";
import { sourceFilePanel } from "../catalog";
import { useFilePanels, type FilePanel } from "../panels";
import { resolveFilePanel, type FilePanelFileKind } from "../resolve";
import { chosenPanelFor, FilePanelChoiceModel, type FilePanelChoiceSnapshot } from "./model";
import { getFilePanelChoice, registerFilePanelChoice, subscribeFilePanelChoices } from "./registry";

export type FilePanelChoice = FilePanelChoiceModel<FilePanel>;

/**
 * The file tab's panel: resolves it from the catalog, the device associations and this tab's
 * choice, and owns the picker and "Open with…" for it.
 */
export function useFilePanelChoice(input: {
  serverId: string;
  targetKey: string | null;
  path: string;
  /** The kind the file's stat reports, or null before the stat. */
  fileKind: FilePanelFileKind | null;
  /** The tab is on screen. */
  presentable: boolean;
  /** Identifies the tab's latest request to show a line, or null when it targets no line. */
  lineNavigation: number | null;
}): { panel: FilePanel | null; choice: FilePanelChoice } {
  const { targetKey, path, fileKind, presentable, lineNavigation } = input;
  const { serverId, workspaceId, tabId } = usePaneContext();
  const candidates = useFilePanels(input.serverId);
  const { associations, remember } = useFilePanelAssociations();
  const [choice] = useState(
    () => new FilePanelChoiceModel<FilePanel>({ remember, linePanelId: sourceFilePanel.id }),
  );
  // From the subscribed snapshot: React Compiler caches reads off the stable model object.
  const chosenPanelId = chosenPanelFor(useFilePanelChoiceSnapshot(choice), targetKey);
  const resolution = useMemo(
    () =>
      fileKind
        ? resolveFilePanel({
            file: { path, kind: fileKind },
            candidates,
            associations,
            choice: chosenPanelId,
          })
        : null,
    [associations, candidates, chosenPanelId, fileKind, path],
  );

  useEffect(() => {
    choice.observe({ targetKey, resolution, presentable, lineNavigation });
  }, [choice, lineNavigation, presentable, resolution, targetKey]);
  useEffect(
    () => registerFilePanelChoice({ serverId, workspaceId, tabId }, choice),
    [choice, serverId, tabId, workspaceId],
  );

  return { panel: resolution?.panel ?? null, choice };
}

const NO_CHOICE_SNAPSHOT: FilePanelChoiceSnapshot<FilePanel> = {
  targetKey: null,
  chosenPanelId: null,
  picker: null,
  openWith: null,
};
const subscribeNothing = () => () => {};
const getNoChoiceSnapshot = () => NO_CHOICE_SNAPSHOT;

/** The choice of an open file tab, looked up by the tab's identity, for chrome outside its pane. */
export function useTabFilePanelChoice(identity: PanelInstanceIdentity): FilePanelChoice | null {
  const { serverId, workspaceId, tabId } = identity;
  const getSnapshot = useCallback(
    () => getFilePanelChoice({ serverId, workspaceId, tabId }),
    [serverId, tabId, workspaceId],
  );
  return useSyncExternalStore(subscribeFilePanelChoices, getSnapshot, getSnapshot);
}

export function useFilePanelChoiceSnapshot(
  choice: FilePanelChoice | null,
): FilePanelChoiceSnapshot<FilePanel> {
  return useSyncExternalStore(
    choice?.subscribe ?? subscribeNothing,
    choice?.getSnapshot ?? getNoChoiceSnapshot,
    choice?.getSnapshot ?? getNoChoiceSnapshot,
  );
}
