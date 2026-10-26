import { useTranslation } from "react-i18next";
import { PLUGINS_LINKED } from "~/plugins/launch";
import { getAlternativePages } from "~/data/alternative-pages";
import { appStoreUrl, playStoreUrl, webAppUrl } from "~/downloads";
import { SponsorsSection } from "~/components/sponsorship";
import { useLocale, useLocalizePath } from "~/i18n";

interface SiteFooterProps {
  width?: "default" | "prose" | "wide";
  /** Pages that show the sponsors in their content turn the footer band off. */
  sponsors?: boolean;
}

const WIDTH_CLASSES: Record<NonNullable<SiteFooterProps["width"]>, string> = {
  prose: "max-w-prose p-6 md:p-12 md:pt-0",
  default: "max-w-5xl p-6 md:p-20 md:pt-0",
  wide: "max-w-7xl p-6 md:p-20 md:pt-0",
};

const LINK_CLASS = "block text-muted-foreground hover:text-foreground transition-colors";

function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={LINK_CLASS}>
      {children}
    </a>
  );
}

export function SiteFooter({ width = "default", sponsors = true }: SiteFooterProps) {
  const { t } = useTranslation();
  const locale = useLocale();
  const localize = useLocalizePath();
  const widthClasses = WIDTH_CLASSES[width];
  const alternatives = getAlternativePages(locale);
  const page = (path: string, label: string) => (
    <a href={localize(path)} className={LINK_CLASS}>
      {label}
    </a>
  );
  return (
    <footer className={`${widthClasses} mx-auto mt-12 md:mt-16`}>
      {sponsors ? <SponsorsSection placement="footer" /> : null}
      <div className="border-t border-white/10 pt-8 pb-4 grid grid-cols-2 sm:grid-cols-5 gap-8 text-sm">
        <div className="space-y-3">
          <p className="text-extra-muted-foreground">{t("footer.product")}</p>
          <div className="space-y-2">
            {page("/blog", t("footer.blog"))}
            {page("/docs", t("footer.docs"))}
            {PLUGINS_LINKED && page("/plugins", t("footer.plugins"))}
            {page("/changelog", t("footer.changelog"))}
            {page("/hub", t("footer.hub"))}
            {page("/docs/cli", t("footer.cli"))}
            {page("/privacy", t("footer.privacy"))}
            {page("/terms", t("footer.terms"))}
            {page("/sponsor", t("footer.sponsor"))}
          </div>
        </div>
        <div className="space-y-3">
          <p className="text-extra-muted-foreground">{t("footer.agents")}</p>
          <div className="space-y-2">
            {page("/claude-code", "Claude Code")}
            {page("/codex", "Codex")}
            {page("/opencode", "OpenCode")}
            {page("/antigravity", "Antigravity")}
            {page("/muse-code", "Muse Code")}
            {page("/agents", t("footer.allProviders"))}
          </div>
        </div>
        <div className="space-y-3">
          <p className="text-extra-muted-foreground">{t("footer.alternatives")}</p>
          <div className="space-y-2">
            {alternatives.map((alternative) => (
              <a key={alternative.slug} href={localize(alternative.href)} className={LINK_CLASS}>
                {alternative.name}
              </a>
            ))}
          </div>
        </div>
        <div className="space-y-3">
          <p className="text-extra-muted-foreground">{t("footer.community")}</p>
          <div className="space-y-2">
            <ExternalLink href="https://discord.gg/jz8T2uahpH">Discord</ExternalLink>
            <ExternalLink href="https://www.reddit.com/r/PaseoAI/">Reddit</ExternalLink>
            <ExternalLink href="https://github.com/getpaseo/paseo">GitHub</ExternalLink>
          </div>
        </div>
        <div className="space-y-3">
          <p className="text-extra-muted-foreground">{t("footer.download")}</p>
          <div className="space-y-2">
            <ExternalLink href={appStoreUrl}>App Store</ExternalLink>
            <ExternalLink href={playStoreUrl}>Google Play</ExternalLink>
            <ExternalLink href="https://github.com/getpaseo/paseo/releases">
              {t("footer.desktop")}
            </ExternalLink>
            <ExternalLink href={webAppUrl}>{t("footer.webApp")}</ExternalLink>
          </div>
        </div>
      </div>
    </footer>
  );
}
