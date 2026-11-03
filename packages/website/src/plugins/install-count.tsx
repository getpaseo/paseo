import { Download } from "lucide-react";
import { useTranslation } from "react-i18next";
import { formatInstalls } from "./registry";

/** An install count as a download icon and the number; inherits the surrounding text style. */
export function InstallCount({ count }: { count: number }) {
  const { t } = useTranslation();
  return (
    <span className="relative inline-flex items-center gap-1 tabular-nums">
      <Download aria-hidden className="h-3 w-3" />
      {formatInstalls(count)}
      <span className="sr-only">{t("plugins.installs")}</span>
    </span>
  );
}
