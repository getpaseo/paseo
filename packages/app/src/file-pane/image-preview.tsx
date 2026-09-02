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
import {
  savePreviewImage,
  sharePreviewImage,
  type ImagePreviewActionPort,
} from "./image-preview-actions";

export interface FileImagePreviewProps {
  uri: string;
  fileName: string;
  attachment: AttachmentMetadata | null;
}

const ThemedCopy = withUnistyles(Copy);
const ThemedSave = withUnistyles(ImageDown);
const ThemedShare = withUnistyles(Share2);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const nativeImageActions: ImagePreviewActionPort = {
  async requestSavePermission() {
    return (await MediaLibrary.requestPermissionsAsync(true, [])).granted;
  },
  saveToPhotoLibrary: MediaLibrary.saveToLibraryAsync,
  async share({ uri, mimeType, fileName }) {
    if (!(await Sharing.isAvailableAsync())) {
      throw new Error("Sharing is unavailable");
    }
    await Sharing.shareAsync(uri, { mimeType, dialogTitle: fileName });
  },
};

export function FileImagePreview({ uri, fileName, attachment }: FileImagePreviewProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const [menuOpen, setMenuOpen] = useState(false);
  const [copyStatus, setCopyStatus] = useState<ActionStatus>("idle");
  const [saveStatus, setSaveStatus] = useState<ActionStatus>("idle");

  const handleCopyImage = useCallback(async () => {
    if (!attachment || copyStatus === "pending") return;
    setCopyStatus("pending");
    try {
      const encoded = await encodeAttachmentsForSend([attachment]);
      const base64 = encoded?.[0]?.data;
      if (!base64) throw new Error("Image encoding failed");
      await Clipboard.setImageAsync(base64);
      setMenuOpen(false);
      setCopyStatus("idle");
      toast.copied();
    } catch {
      setCopyStatus("idle");
      toast.error(t("panels.file.image.copyFailed"));
    }
  }, [attachment, copyStatus, t, toast]);

  const handleSaveImage = useCallback(async () => {
    if (saveStatus === "pending") return;
    setSaveStatus("pending");
    try {
      const result = await savePreviewImage(uri, nativeImageActions);
      if (result === "permission-denied") {
        setSaveStatus("idle");
        toast.error(t("panels.file.image.savePermissionDenied"));
        return;
      }
      setSaveStatus("success");
      setMenuOpen(false);
      toast.show(t("panels.file.image.saved"), { variant: "success" });
      setSaveStatus("idle");
    } catch {
      setSaveStatus("idle");
      toast.error(t("panels.file.image.saveFailed"));
    }
  }, [saveStatus, t, toast, uri]);

  const shareImage = useCallback(async () => {
    try {
      await sharePreviewImage(
        { uri, mimeType: attachment?.mimeType ?? "image/*", fileName },
        nativeImageActions,
      );
    } catch {
      toast.error(t("panels.file.image.shareFailed"));
    }
  }, [attachment?.mimeType, fileName, t, toast, uri]);

  const handleShareImage = useCallback(() => {
    void shareImage();
  }, [shareImage]);

  const handleAccessibilityAction = useCallback(
    (event: AccessibilityActionEvent) => {
      if (event.nativeEvent.actionName === "copyImage") {
        void handleCopyImage();
      } else if (event.nativeEvent.actionName === "saveImage") {
        void handleSaveImage();
      } else if (event.nativeEvent.actionName === "shareImage") {
        void shareImage();
      }
    },
    [handleCopyImage, handleSaveImage, shareImage],
  );
  const handleSelectCopyImage = useCallback(() => void handleCopyImage(), [handleCopyImage]);
  const handleSelectSaveImage = useCallback(() => void handleSaveImage(), [handleSaveImage]);
  const copyLeading = useMemo(() => <ThemedCopy size={16} uniProps={mutedColorMapping} />, []);
  const saveLeading = useMemo(() => <ThemedSave size={16} uniProps={mutedColorMapping} />, []);
  const shareLeading = useMemo(() => <ThemedShare size={16} uniProps={mutedColorMapping} />, []);

  return (
    <View style={nativeStyles.container}>
      <ContextMenu open={menuOpen} onOpenChange={setMenuOpen} compactMode="popover">
        <ContextMenuTrigger
          enabledOnMobile
          enabledOnWeb={false}
          style={nativeStyles.trigger}
          testID="workspace-file-image-actions"
          accessibilityRole="imagebutton"
          accessibilityLabel={t("panels.file.image.accessibilityLabel", { fileName })}
          accessibilityHint={t("panels.file.image.accessibilityHint")}
          accessibilityActions={[
            { name: "copyImage", label: t("panels.file.image.copy") },
            { name: "saveImage", label: t("panels.file.image.save") },
            { name: "shareImage", label: t("workspace.fileActions.share") },
          ]}
          onAccessibilityAction={handleAccessibilityAction}
        >
          <ZoomableImage
            accessibilityLabel={t("panels.file.image.accessibilityLabel", { fileName })}
            style={nativeStyles.viewport}
            testID="workspace-file-image"
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
            onSelect={handleSelectCopyImage}
          >
            {t("panels.file.image.copy")}
          </ContextMenuItem>
          <ContextMenuItem
            closeOnSelect={false}
            status={saveStatus}
            pendingLabel={t("panels.file.image.saving")}
            successLabel={t("panels.file.image.saved")}
            leading={saveLeading}
            onSelect={handleSelectSaveImage}
          >
            {t("panels.file.image.save")}
          </ContextMenuItem>
          <ContextMenuItem leading={shareLeading} onSelect={handleShareImage}>
            {t("workspace.fileActions.share")}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </View>
  );
}

const nativeStyles = StyleSheet.create({
  container: {
    flex: 1,
    minHeight: 0,
  },
  trigger: {
    flex: 1,
    minHeight: 0,
    margin: 16,
    overflow: "hidden",
  },
  viewport: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
});
