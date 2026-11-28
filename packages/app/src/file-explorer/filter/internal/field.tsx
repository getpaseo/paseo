import { useCallback, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { SearchField } from "@/components/ui/search-field";
import { useFileFilterStore } from "./store";

export function FileFilterField({ stateKey }: { stateKey: string }): ReactElement {
  const { t } = useTranslation();
  const query = useFileFilterStore((state) => state.queryByStateKey[stateKey] ?? "");
  const setQuery = useFileFilterStore((state) => state.setQuery);
  const handleChange = useCallback(
    (next: string) => setQuery(stateKey, next),
    [setQuery, stateKey],
  );

  return (
    <SearchField
      size="sm"
      fullWidth
      clearOnEscape
      value={query}
      onChangeText={handleChange}
      placeholder={t("workspace.fileExplorer.filter.placeholder")}
      clearAccessibilityLabel={t("workspace.fileExplorer.filter.clear")}
      testID="files-filter-input"
      clearTestID="files-filter-clear"
    />
  );
}
