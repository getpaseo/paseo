import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { ProviderDetail, useProviderDetail } from "./provider-detail";
import { ProviderGlyph } from "./provider-glyph";
import { OVERLAY_SHEET_FRAME, type ProviderSheetFrame } from "./sheet-frame";

/** A provider's detail as a sheet, for surfaces with no Settings route to push. */
export function ProviderDetailSheet({
  serverId,
  provider,
  visible,
  onClose,
  frame = OVERLAY_SHEET_FRAME,
}: {
  serverId: string;
  provider: string;
  visible: boolean;
  onClose: () => void;
  frame?: ProviderSheetFrame;
}) {
  const { t } = useTranslation();
  const detail = useProviderDetail({ serverId, provider, onRemoved: onClose });
  const label = detail.label;
  const header = useMemo<SheetHeader>(
    () => ({
      title: label,
      leading: <ProviderGlyph serverId={serverId} provider={provider} />,
      back: frame.returns
        ? {
            onPress: onClose,
            accessibilityLabel: t("settings.providers.detail.backToProviders"),
          }
        : undefined,
    }),
    [frame.returns, label, onClose, provider, serverId, t],
  );
  return (
    <AdaptiveModalSheet
      header={header}
      showCloseButton={!frame.returns}
      visible={visible}
      onClose={onClose}
      snapPoints={frame.snapPoints}
      desktopMaxWidth={frame.desktopMaxWidth}
      desktopHeight={frame.desktopHeight}
      testID="provider-settings-sheet"
    >
      <ProviderDetail serverId={serverId} detail={detail} />
    </AdaptiveModalSheet>
  );
}
