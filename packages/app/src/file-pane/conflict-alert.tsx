import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useTranslation } from "react-i18next";

export function FileConflictAlert({
  unavailable,
  onOverwrite,
  onReload,
}: {
  unavailable: boolean;
  onOverwrite(): void;
  onReload(): void;
}) {
  const { t } = useTranslation();
  return (
    <Alert
      variant="warning"
      title={
        unavailable
          ? t("panels.file.editor.unavailableTitle")
          : t("panels.file.editor.changedOnDisk")
      }
      description={t("panels.file.editor.conflictDescription")}
      testID="file-conflict-alert"
    >
      <Button variant="outline" size="sm" onPress={onOverwrite} disabled={unavailable}>
        {t("panels.file.editor.overwrite")}
      </Button>
      <Button variant="outline" size="sm" onPress={onReload} disabled={unavailable}>
        {t("panels.file.editor.reload")}
      </Button>
    </Alert>
  );
}
