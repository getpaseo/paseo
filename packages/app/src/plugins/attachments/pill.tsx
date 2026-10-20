import { useCallback, useMemo } from "react";
import { withUnistyles } from "react-native-unistyles";
import { AttachmentLabel, AttachmentPill } from "@/components/attachment-pill";
import type { ComposerAttachment } from "@/attachments/types";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import type { PluginSerializableIcon } from "@getpaseo/plugin";
import { PluginIconView } from "../icons";
import type { PluginResourceComposerAttachment } from "./model";

const iconColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function ResourceIcon({ icon, color = "" }: { icon: PluginSerializableIcon; color?: string }) {
  return <PluginIconView icon={icon} size={ICON_SIZE.sm} color={color} />;
}

const ThemedResourceIcon = withUnistyles(ResourceIcon);

interface PluginResourceAttachmentPillProps {
  attachment: PluginResourceComposerAttachment;
  index: number;
  disabled: boolean;
  onOpen: (attachment: ComposerAttachment) => void;
  onRemove: (index: number) => void;
  openLabel: (kind: string, identifier: string) => string;
  removeLabel: (kind: string, identifier: string) => string;
}

export function PluginResourceAttachmentPill({
  attachment,
  index,
  disabled,
  onOpen,
  onRemove,
  openLabel,
  removeLabel,
}: PluginResourceAttachmentPillProps) {
  const handleOpen = useCallback(() => onOpen(attachment), [attachment, onOpen]);
  const handleRemove = useCallback(() => onRemove(index), [index, onRemove]);
  const icon = useMemo(
    () => <ThemedResourceIcon icon={attachment.sourceIcon} uniProps={iconColorMapping} />,
    [attachment.sourceIcon],
  );
  return (
    <AttachmentPill
      testID="composer-plugin-resource-attachment-pill"
      onOpen={handleOpen}
      onRemove={handleRemove}
      openAccessibilityLabel={openLabel(attachment.sourceTitle, attachment.item.identifier)}
      removeAccessibilityLabel={removeLabel(attachment.sourceTitle, attachment.item.identifier)}
      disabled={disabled}
    >
      <AttachmentLabel
        icon={icon}
        title={attachment.item.title}
        subtitle={`${attachment.sourceTitle} ${attachment.item.identifier}`}
      />
    </AttachmentPill>
  );
}
