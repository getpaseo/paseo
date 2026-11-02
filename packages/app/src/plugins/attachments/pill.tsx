import { useInstalledPlugin } from "../registry";
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
  serverId: string;
  attachment: PluginResourceComposerAttachment;
  index: number;
  disabled: boolean;
  onOpen: (attachment: ComposerAttachment) => void;
  onRemove: (index: number) => void;
  openLabel: (kind: string, identifier: string) => string;
  removeLabel: (kind: string, identifier: string) => string;
}

export function PluginResourceAttachmentPill({
  serverId,
  attachment,
  index,
  disabled,
  onOpen,
  onRemove,
  openLabel,
  removeLabel,
}: PluginResourceAttachmentPillProps) {
  const plugin = useInstalledPlugin(serverId, attachment.pluginId);
  const source = plugin?.attachmentSources.find(
    (candidate) => candidate.id === attachment.sourceId,
  );
  // Keep the saved label when the source is no longer installed.
  const sourceTitle =
    plugin && source ? plugin.i18n.resolve(source.title, plugin.locale) : attachment.sourceTitle;
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
      openAccessibilityLabel={openLabel(sourceTitle, attachment.item.identifier)}
      removeAccessibilityLabel={removeLabel(sourceTitle, attachment.item.identifier)}
      disabled={disabled}
    >
      <AttachmentLabel
        icon={icon}
        title={attachment.item.title}
        subtitle={`${sourceTitle} ${attachment.item.identifier}`}
      />
    </AttachmentPill>
  );
}
