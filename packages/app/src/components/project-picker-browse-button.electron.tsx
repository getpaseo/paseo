import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { FolderOpen } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { pickDirectory } from "@/desktop/pick-directory";
import { useIsLocalDaemon } from "@/hooks/use-is-local-daemon";
import type { ProjectPickerBrowseButtonProps } from "./project-picker-browse-button.types";

export function ProjectPickerBrowseButton({
  serverId,
  disabled,
  onSelect,
  onError,
}: ProjectPickerBrowseButtonProps) {
  const { t } = useTranslation();
  const isLocalDaemon = useIsLocalDaemon(serverId);
  const handlePress = useCallback(() => {
    void (async () => {
      try {
        const path = await pickDirectory();
        if (path) {
          onSelect(path);
        }
      } catch {
        onError();
      }
    })();
  }, [onError, onSelect]);

  if (!isLocalDaemon) {
    return null;
  }

  return (
    <Button
      variant="outline"
      size="sm"
      leftIcon={FolderOpen}
      disabled={disabled}
      onPress={handlePress}
    >
      {t("projectPicker.browse")}
    </Button>
  );
}
