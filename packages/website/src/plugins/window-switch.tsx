import { useTranslation } from "react-i18next";
import type { InstallWindow } from "./installs";

const WINDOWS: readonly InstallWindow[] = ["week", "month", "all"];

/** Plain text time-window switch for install rankings. */
export function WindowSwitch({
  current,
  hrefs,
}: {
  current: InstallWindow;
  hrefs: Record<InstallWindow, string>;
}) {
  const { t } = useTranslation();
  return (
    <nav aria-label={t("plugins.window.label")} className="flex items-baseline gap-4 text-sm">
      {WINDOWS.map((option) => (
        <a
          key={option}
          href={hrefs[option]}
          aria-current={option === current ? "true" : undefined}
          className={
            option === current
              ? "text-foreground"
              : "text-extra-muted-foreground transition-colors hover:text-muted-foreground"
          }
        >
          {t(`plugins.window.${option}`)}
        </a>
      ))}
    </nav>
  );
}
