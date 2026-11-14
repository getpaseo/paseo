import { PackagePlus } from "lucide-react-native";
import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { SvgXml } from "react-native-svg";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { rankProviderCatalog } from "@/components/provider-catalog-search";
import { SettingsCard, SettingsRow } from "@/components/settings";
import { Button } from "@/components/ui/button";
import {
  useAcpProviderCatalog,
  type AcpProviderCatalogItem,
} from "@/hooks/use-acp-provider-catalog";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { settingsStyles } from "@/styles/settings";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { useProviderConfigActions } from "./provider-config";
import { OVERLAY_SHEET_FRAME, type ProviderSheetFrame } from "./sheet-frame";

const ThemedPackagePlus = withUnistyles(PackagePlus);
const ThemedSvgXml = withUnistyles(SvgXml);
const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });

export interface AddProviderSheetProps {
  serverId: string;
  visible: boolean;
  onClose: () => void;
  /** The provider is in config and listed; open its detail. */
  onAdded: (providerId: string) => void;
  frame?: ProviderSheetFrame;
}

/** The catalog of providers not added yet, searchable, each with Add. */
export function AddProviderSheet({
  serverId,
  visible,
  onClose,
  onAdded,
  frame = OVERLAY_SHEET_FRAME,
}: AddProviderSheetProps) {
  const { t } = useTranslation();
  const { entries: catalog } = useAcpProviderCatalog();
  const { entries: providers } = useProvidersSnapshot(serverId);
  const { add, addingProviderId } = useProviderConfigActions(serverId);
  const [search, setSearch] = useState("");
  // Each opening starts from an empty search; the field clears when this changes.
  const [session, setSession] = useState(0);
  // Read when an add finishes, to tell whether the sheet it started in is still open.
  const sessionRef = useRef(0);
  const endSession = useCallback(() => {
    setSearch("");
    sessionRef.current += 1;
    setSession(sessionRef.current);
  }, []);
  const handleClose = useCallback(() => {
    endSession();
    onClose();
  }, [endSession, onClose]);

  const available = useMemo(() => {
    const added = new Set(providers?.map((entry) => entry.provider) ?? []);
    return rankProviderCatalog(
      catalog.filter((entry) => !added.has(entry.id)),
      search,
    );
  }, [catalog, providers, search]);

  const handleAdd = useCallback(
    (entry: AcpProviderCatalogItem) => {
      const startedIn = sessionRef.current;
      void add(entry).then((added) => {
        // Closed before the add finished: the provider is added, but the user has moved on.
        if (!added || sessionRef.current !== startedIn) return added;
        endSession();
        onAdded(entry.id);
        return added;
      });
    },
    [add, endSession, onAdded],
  );

  const header = useMemo<SheetHeader>(
    () => ({
      title: t("settings.providers.addProvider"),
      back: frame.returns
        ? {
            onPress: handleClose,
            accessibilityLabel: t("settings.providers.detail.backToProviders"),
          }
        : undefined,
      search: {
        onChange: setSearch,
        placeholder: t("providerCatalog.search"),
        resetKey: session,
        testID: "provider-catalog-search",
      },
    }),
    [frame.returns, handleClose, session, t],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={handleClose}
      showCloseButton={!frame.returns}
      desktopMaxWidth={frame.desktopMaxWidth}
      desktopHeight={frame.desktopHeight}
      snapPoints={frame.snapPoints}
      testID="add-provider-sheet"
    >
      <SettingsCard>
        {available.length === 0 ? (
          <View style={settingsStyles.row}>
            <Text style={styles.empty}>{t("providerCatalog.noProviders")}</Text>
          </View>
        ) : (
          available.map((entry) => (
            <CatalogRow
              key={entry.id}
              entry={entry}
              adding={addingProviderId === entry.id}
              disabled={addingProviderId !== null}
              onAdd={handleAdd}
            />
          ))
        )}
      </SettingsCard>
    </AdaptiveModalSheet>
  );
}

function CatalogRow({
  entry,
  adding,
  disabled,
  onAdd,
}: {
  entry: AcpProviderCatalogItem;
  adding: boolean;
  disabled: boolean;
  onAdd: (entry: AcpProviderCatalogItem) => void;
}) {
  const { t } = useTranslation();
  const handleAdd = useCallback(() => onAdd(entry), [entry, onAdd]);
  const icon = useMemo(
    () =>
      entry.iconSvg ? (
        <ThemedSvgXml
          xml={entry.iconSvg}
          width={ICON_SIZE.md}
          height={ICON_SIZE.md}
          uniProps={foregroundColorMapping}
        />
      ) : (
        <ThemedPackagePlus size={ICON_SIZE.md} uniProps={foregroundColorMapping} />
      ),
    [entry.iconSvg],
  );
  return (
    <SettingsRow
      leading={icon}
      label={entry.title}
      hint={entry.description}
      testID={`provider-catalog-row-${entry.id}`}
    >
      <Button
        variant="outline"
        onPress={handleAdd}
        loading={adding}
        disabled={disabled}
        accessibilityLabel={t("providerCatalog.actions.addProvider", { provider: entry.title })}
        testID={`install-provider-${entry.id}`}
      >
        {adding ? t("providerCatalog.actions.adding") : t("providerCatalog.actions.add")}
      </Button>
    </SettingsRow>
  );
}

const styles = StyleSheet.create((theme) => ({
  empty: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
}));
