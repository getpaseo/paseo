import { useCallback, useState } from "react";
import { View } from "react-native";
import { ProviderDetailSheet, ProviderList, type ProviderSheetFrame } from "@/provider-settings";
import { SETUP_CARD_FRAME } from "../setup-card";

/** Provider sheets cover the setup card and return to it, so they read as pages of setup. */
const SETUP_SHEET_FRAME: ProviderSheetFrame = { ...SETUP_CARD_FRAME, returns: true };

interface OpenedProvider {
  provider: string;
  visible: boolean;
}

export function ProvidersStep({ serverId }: { serverId: string }) {
  // The provider outlives `visible` so the sheet can animate out.
  const [opened, setOpened] = useState<OpenedProvider | null>(null);
  const openProvider = useCallback(
    (provider: string) => setOpened({ provider, visible: true }),
    [],
  );
  const closeProvider = useCallback(
    () => setOpened((current) => (current ? { ...current, visible: false } : null)),
    [],
  );
  return (
    <View>
      <ProviderList
        serverId={serverId}
        onOpenProvider={openProvider}
        sheetFrame={SETUP_SHEET_FRAME}
      />
      {opened ? (
        <ProviderDetailSheet
          key={opened.provider}
          serverId={serverId}
          provider={opened.provider}
          visible={opened.visible}
          onClose={closeProvider}
          frame={SETUP_SHEET_FRAME}
        />
      ) : null}
    </View>
  );
}
