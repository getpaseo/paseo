import { useTranslation } from "react-i18next";
import { PLUGINS_LINKED } from "~/plugins/launch";
import "~/styles.css";
import { DiscordIcon, GitHubIcon } from "~/components/brand-icons";
import { LanguageSelector } from "~/components/language-selector";
import { useLocalizePath } from "~/i18n";
import { useStars } from "~/routes/__root";

const NAV_LINK_CLASS = "text-sm text-muted-foreground hover:text-foreground transition-colors";

export function SiteHeader() {
  const { t } = useTranslation();
  const localize = useLocalizePath();
  const { stars } = useStars();
  return (
    <header className="flex flex-col items-center gap-4 md:flex-row md:justify-between">
      <a href={localize("/")} className="flex items-center gap-3">
        <img src="/logo.svg" alt="Paseo" className="w-6 h-6" />
        <span className="text-lg font-medium">Paseo</span>
      </a>
      <div className="flex flex-wrap items-center justify-center gap-4">
        {PLUGINS_LINKED && (
          <a href={localize("/plugins")} className={NAV_LINK_CLASS}>
            {t("nav.plugins")}
          </a>
        )}
        <a href={localize("/blog")} className={NAV_LINK_CLASS}>
          {t("nav.blog")}
        </a>
        <a href={localize("/docs")} className={NAV_LINK_CLASS}>
          {t("nav.docs")}
        </a>
        <a href={localize("/changelog")} className={NAV_LINK_CLASS}>
          {t("nav.changelog")}
        </a>
        <a href={localize("/download")} className={NAV_LINK_CLASS}>
          {t("nav.download")}
        </a>
        <a href={localize("/sponsor")} className={NAV_LINK_CLASS}>
          {t("nav.sponsor")}
        </a>
        <LanguageSelector />
        <a
          href="https://discord.gg/jz8T2uahpH"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Discord"
          className="text-muted-foreground hover:text-foreground transition-colors inline-flex items-center"
        >
          <DiscordIcon width="18" height="18" />
        </a>
        <a
          href="https://github.com/getpaseo/paseo"
          target="_blank"
          rel="noopener noreferrer"
          aria-label={stars ? t("nav.githubStars", { stars }) : "GitHub"}
          className="text-muted-foreground hover:text-foreground transition-colors inline-flex items-center gap-1.5"
        >
          <GitHubIcon width="18" height="18" />
          {stars && <span className="text-sm">{stars}</span>}
        </a>
      </div>
    </header>
  );
}
