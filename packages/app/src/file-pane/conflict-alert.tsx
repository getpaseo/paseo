import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

export function FileConflictAlert({
  unavailable,
  onOverwrite,
  onReload,
}: {
  unavailable: boolean;
  onOverwrite(): void;
  onReload(): void;
}) {
  return (
    <Alert
      variant="warning"
      title={unavailable ? "File unavailable on disk" : "Changed on disk"}
      description="The local buffer was preserved. Choose which version to keep."
      testID="file-conflict-alert"
    >
      <Button variant="outline" size="sm" onPress={onOverwrite} disabled={unavailable}>
        Overwrite
      </Button>
      <Button variant="outline" size="sm" onPress={onReload} disabled={unavailable}>
        Reload
      </Button>
    </Alert>
  );
}
