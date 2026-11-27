import { RotateCw } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useTimeAgo } from "@/hooks/use-time-ago";

/** Asking the provider again for its status, version and models. */
export interface ProviderRefresh {
  /** When the provider last answered. Absent before its first answer. */
  checkedAt: string | undefined;
  /** A check is running, whoever asked for it. */
  busy: boolean;
  run: () => void;
}

/** "Checked 5m ago", kept current, or nothing before the provider's first answer. */
export function useCheckedLabel(refresh: ProviderRefresh): string | undefined {
  const { t } = useTranslation();
  const time = useTimeAgo(refresh.checkedAt ? new Date(refresh.checkedAt) : null);
  return refresh.checkedAt ? t("settings.providers.detail.checked", { time }) : undefined;
}

export function ProviderRefreshButton({
  refresh,
  form,
}: {
  refresh: ProviderRefresh;
  /** `icon` in a section header, `labelled` in a row. */
  form: "icon" | "labelled";
}) {
  const { t } = useTranslation();
  const label = refresh.busy
    ? t("settings.providers.diagnostic.refreshing")
    : t("settings.providers.diagnostic.refresh");
  if (form === "icon")
    return (
      <Button
        variant="ghost"
        leftIcon={RotateCw}
        onPress={refresh.run}
        loading={refresh.busy}
        accessibilityLabel={label}
        testID="provider-refresh"
      />
    );
  return (
    <Button
      variant="outline"
      onPress={refresh.run}
      loading={refresh.busy}
      testID="provider-refresh"
    >
      {label}
    </Button>
  );
}
