import { useCallback, useMemo, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { withUnistyles } from "react-native-unistyles";
import {
  MenuItem,
  MenuSeparator,
  MenuSubTrigger,
  type MenuPageDefinition,
} from "@/components/ui/menu";
import type { PanelInstanceIdentity } from "@/panels/panel-instance-attributes";
import { PluginIconView } from "@/plugins/icons";
import type { Theme } from "@/styles/theme";
import type { FilePanel } from "../panels";
import { useFilePanelChoiceSnapshot, useTabFilePanelChoice, type FilePanelChoice } from "./hook";
import { filePanelAlwaysUseLabel, filePanelIcon, filePanelOptionLabel } from "./presentation";

const OPEN_WITH_PAGE_ID = "filePanelOpenWith";
const MENU_ICON_SIZE = 16;

const ThemedPanelIcon = withUnistyles(PluginIconView);
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const NO_PAGES: readonly MenuPageDefinition[] = [];

export interface FilePanelOpenWithMenu {
  /** The "Open with…" row, or null when the file has one panel or none. */
  trigger: ReactElement | null;
  /** The page the row opens; pass to the menu surface. */
  pages: readonly MenuPageDefinition[];
}

/** "Open with…" for a file tab's context menu, found by the tab's identity. */
export function useFilePanelOpenWithMenu(
  identity: PanelInstanceIdentity,
  testIDBase: string,
): FilePanelOpenWithMenu {
  return useOpenWithMenu(useTabFilePanelChoice(identity), testIDBase);
}

function useOpenWithMenu(
  choice: FilePanelChoice | null,
  testIDBase: string,
): FilePanelOpenWithMenu {
  const { t } = useTranslation();
  const { openWith } = useFilePanelChoiceSnapshot(choice);
  return useMemo(() => {
    if (!choice || !openWith) return { trigger: null, pages: NO_PAGES };
    const title = t("panels.file.filePanels.openWith");
    return {
      trigger: (
        <MenuSubTrigger id={OPEN_WITH_PAGE_ID} testID={`${testIDBase}-open-with`}>
          {title}
        </MenuSubTrigger>
      ),
      pages: [
        {
          id: OPEN_WITH_PAGE_ID,
          title,
          content: (
            <>
              {openWith.candidates.map((panel) => (
                <OpenWithItem
                  key={panel.id}
                  choice={choice}
                  panel={panel}
                  label={filePanelOptionLabel(t, panel)}
                  selected={panel.id === openWith.activePanelId}
                  testID={`${testIDBase}-open-with-${panel.id}`}
                />
              ))}
              <MenuSeparator />
              <AlwaysUseItem
                choice={choice}
                label={filePanelAlwaysUseLabel(t, openWith.selectorKey)}
                selected={openWith.remembered}
                testID={`${testIDBase}-always-use`}
              />
            </>
          ),
        },
      ],
    };
  }, [choice, openWith, t, testIDBase]);
}

function OpenWithItem({
  choice,
  panel,
  label,
  selected,
  testID,
}: {
  choice: FilePanelChoice;
  panel: FilePanel;
  label: string;
  selected: boolean;
  testID: string;
}) {
  const handleSelect = useCallback(() => choice.openWith(panel.id), [choice, panel.id]);
  const leading = useMemo(
    () => (
      <ThemedPanelIcon
        icon={filePanelIcon(panel)}
        size={MENU_ICON_SIZE}
        uniProps={mutedIconMapping}
      />
    ),
    [panel],
  );
  return (
    <MenuItem selected={selected} leading={leading} onSelect={handleSelect} testID={testID}>
      {label}
    </MenuItem>
  );
}

function AlwaysUseItem({
  choice,
  label,
  selected,
  testID,
}: {
  choice: FilePanelChoice;
  label: string;
  selected: boolean;
  testID: string;
}) {
  const handleSelect = useCallback(() => choice.toggleAlwaysUse(), [choice]);
  return (
    <MenuItem selected={selected} onSelect={handleSelect} testID={testID}>
      {label}
    </MenuItem>
  );
}
