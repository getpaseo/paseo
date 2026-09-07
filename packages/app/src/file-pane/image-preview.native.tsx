import { encodeAttachmentsForSend } from "@/attachments/service";
import type { AttachmentMetadata } from "@/attachments/types";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  type ActionStatus,
} from "@/components/ui/context-menu";
import { ZoomableImage } from "@/components/zoomable-viewport/image";
import { useToast } from "@/contexts/toast-context";
import type { Theme } from "@/styles/theme";
import * as Clipboard from "expo-clipboard";
import * as MediaLibrary from "expo-media-library";
import * as Sharing from "expo-sharing";
import { Copy, ImageDown, Share2 } from "lucide-react-native";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View, type AccessibilityActionEvent } from "react-native";
import { withUnistyles } from "react-native-unistyles";
import { savePreviewImage, type ImagePreviewLibrary } from "./image-preview-save";

export interface FileImagePreviewProps {
  uri: string;
  fileName: string;
  attachment: AttachmentMetadata | null;
}

const ThemedCopy = withUnistyles(Copy);
const ThemedSave = withUnistyles(ImageDown);
const ThemedShare = withUnistyles(Share2);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const imageLibrary: ImagePreviewLibrary = {
  async requestSavePermission() {
    return (await MediaLibrary.requestPermissionsAsync(true, [])).granted;
  },
  saveToPhotoLibrary: MediaLibrary.saveToLibraryAsync,
};

export function FileImagePreview({ uri, fileName, attachment }: FileImagePreviewProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const [menuOpen, setMenuOpen] = useState(false);
  const [copyStatus, setCopyStatus] = useState<ActionStatus>("idle");
  const [saveStatus, setSaveStatus] = useState<ActionStatus>("idle");
  const [shareStatus, setShareStatus] = useState<ActionStatus>("idle");

  const copyImage = useCallback(async () => {
    if (!attachment || copyStatus === "pending") return;
    setCopyStatus("pending");
    try {
      const encoded = await encodeAttachmentsForSend([attachment]);
      const base64 = encoded?.[0]?.data;
      if (!base64) throw new Error("Image encoding failed");
      await Clipboard.setImageAsync(base64);
      setMenuOpen(false);
      toast.copied();
    } catch {
      toast.error(t("panels.file.image.copyFailed"));
    } finally {
      setCopyStatus("idle");
    }
  }, [attachment, copyStatus, t, toast]);

  const saveImage = useCallback(async () => {
    if (saveStatus === "pending") return;
    setSaveStatus("pending");
    try {
      const result = await savePreviewImage(uri, imageLibrary);
      if (result === "permission-denied") {
        toast.error(t("panels.file.image.savePermissionDenied"));
        return;
      }
      setMenuOpen(false);
      toast.show(t("panels.file.image.saved"), { variant: "success" });
    } catch {
      toast.error(t("panels.file.image.saveFailed"));
    } finally {
      setSaveStatus("idle");
    }
  }, [saveStatus, t, toast, uri]);

  const shareImage = useCallback(async () => {
    if (shareStatus === "pending") return;
    setShareStatus("pending");
    try {
      if (!(await Sharing.isAvailableAsync())) {
        throw new Error("Sharing is unavailable");
      }
      await Sharing.shareAsync(uri, {
        mimeType: attachment?.mimeType ?? "image/*",
        dialogTitle: fileName,
      });
      setMenuOpen(false);
    } catch {
      toast.error(t("panels.file.image.shareFailed"));
    } finally {
      setShareStatus("idle");
    }
  }, [attachment?.mimeType, fileName, shareStatus, t, toast, uri]);

  const handleAccessibilityAction = useCallback(
    (event: AccessibilityActionEvent) => {
      if (event.nativeEvent.actionName === "copyImage") {
        void copyImage();
      } else if (event.nativeEvent.actionName === "saveImage") {
        void saveImage();
      } else if (event.nativeEvent.actionName === "shareImage") {
        void shareImage();
      }
    },
    [copyImage, saveImage, shareImage],
  );
  const handleCopy = useCallback(() => void copyImage(), [copyImage]);
  const handleSave = useCallback(() => void saveImage(), [saveImage]);
  const handleShare = useCallback(() => void shareImage(), [shareImage]);
  const copyLeading = useMemo(() => <ThemedCopy size={16} uniProps={mutedColorMapping} />, []);
  const saveLeading = useMemo(() => <ThemedSave size={16} uniProps={mutedColorMapping} />, []);
  const shareLeading = useMemo(() => <ThemedShare size={16} uniProps={mutedColorMapping} />, []);

  return (
    <View style={styles.container}>
      <ContextMenu open={menuOpen} onOpenChange={setMenuOpen} compactMode="popover">
        <ContextMenuTrigger
          enabledOnMobile
          style={styles.trigger}
          testID="workspace-file-image-actions"
          accessibilityRole="imagebutton"
          accessibilityLabel={t("panels.file.image.accessibilityLabel", { fileName })}
          accessibilityHint={t("panels.file.image.accessibilityHint")}
          accessibilityActions={[
            { name: "copyImage", label: t("panels.file.image.copy") },
            { name: "saveImage", label: t("panels.file.image.save") },
            { name: "shareImage", label: t("panels.file.image.share") },
          ]}
          onAccessibilityAction={handleAccessibilityAction}
        >
          <ZoomableImage
            accessibilityLabel={t("panels.file.image.accessibilityLabel", { fileName })}
            style={styles.viewport}
            testID="image-file-preview"
            uri={uri}
          />
        </ContextMenuTrigger>
        <ContextMenuContent align="center" testID="file-image-actions-menu">
          <ContextMenuItem
            closeOnSelect={false}
            disabled={!attachment}
            status={copyStatus}
            pendingLabel={t("panels.file.image.copying")}
            leading={copyLeading}
            onSelect={handleCopy}
          >
            {t("panels.file.image.copy")}
          </ContextMenuItem>
          <ContextMenuItem
            closeOnSelect={false}
            status={saveStatus}
            pendingLabel={t("panels.file.image.saving")}
            leading={saveLeading}
            onSelect={handleSave}
          >
            {t("panels.file.image.save")}
          </ContextMenuItem>
          <ContextMenuItem
            closeOnSelect={false}
            status={shareStatus}
            pendingLabel={t("panels.file.image.sharing")}
            leading={shareLeading}
            onSelect={handleShare}
          >
            {t("panels.file.image.share")}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    minHeight: 0,
  },
  trigger: {
    flex: 1,
    minHeight: 0,
    overflow: "hidden",
  },
  viewport: {
    flex: 1,
    minHeight: 0,
  },
});
