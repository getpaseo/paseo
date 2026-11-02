import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useLocalizePath } from "~/i18n";

export interface BreadcrumbItem {
  label: string;
  /** Language-neutral internal path. The last item is the current page and has no href. */
  href?: string;
}

export function Breadcrumbs({ items }: { items: BreadcrumbItem[] }) {
  const { t } = useTranslation();
  const localize = useLocalizePath();
  return (
    <nav aria-label={t("common.breadcrumb")} className="not-prose mb-6">
      <ol className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        {items.map((item, index) => {
          const last = index === items.length - 1;
          return (
            <li key={`${item.href ?? ""}#${item.label}`} className="flex items-center gap-2">
              {index > 0 && <ChevronRight size={14} className="text-border" />}
              {item.href && !last ? (
                <Link to={localize(item.href)} className="hover:text-foreground transition-colors">
                  {item.label}
                </Link>
              ) : (
                <span className={last ? "text-foreground" : undefined}>{item.label}</span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
