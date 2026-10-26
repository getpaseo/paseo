import { ChevronDown } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { mutedIconColorMapping } from "@/components/ui/icon-color";
import { useIsCompactFormFactor } from "@/constants/layout";
import { ICON_SIZE } from "@/styles/theme";

const ThemedChevronDown = withUnistyles(ChevronDown);

interface SendOptionsProps {
  disabled: boolean;
  immediateBehavior: "steer" | "interrupt";
  onSend: () => void;
  onQueue: () => void;
}

export function SendOptions({ disabled, immediateBehavior, onSend, onQueue }: SendOptionsProps) {
  const { t } = useTranslation();
  const compact = useIsCompactFormFactor();
  const immediateLabel = t(
    immediateBehavior === "steer"
      ? "composer.input.sendAndSteer"
      : "composer.input.sendAndInterrupt",
  );
  const label = t("composer.input.sendOptions");
  return (
    <DropdownMenu compactMode="sheet">
      <ToolbarButton
        kind="menu"
        label={label}
        disabled={disabled}
        compact={compact}
        round
        testID="composer-send-options"
      >
        <ThemedChevronDown size={ICON_SIZE.md} uniProps={mutedIconColorMapping} />
      </ToolbarButton>
      <DropdownMenuContent align="end" side="top" width={240} sheetTitle={label}>
        <DropdownMenuItem onSelect={onQueue} testID="composer-send-options-queue">
          {t("composer.input.queueMessage")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onSend} testID="composer-send-options-now">
          {immediateLabel}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
