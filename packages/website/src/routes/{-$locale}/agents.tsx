import * as React from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ExternalLink } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
import { AgentPageIcon } from "~/components/agent-page-icon";
import { SiteShell } from "~/components/site-shell";
import { AGENT_PAGES } from "~/data/agent-pages";
import { getTranslator, routeLocale, useLocalizePath } from "~/i18n";
import { pageMeta } from "~/meta";
import "~/styles.css";

export const Route = createFileRoute("/{-$locale}/agents")({
  head: ({ params }) => {
    const locale = routeLocale(params);
    const t = getTranslator(locale);
    return pageMeta({
      title: t("agents.metaTitle"),
      description: t("agents.metaDescription"),
      path: "/agents",
      locale,
    });
  },
  component: AgentsPage,
});

const LINK_CLASS = "underline hover:text-white";

function AgentsPage() {
  const { t } = useTranslation();
  const localize = useLocalizePath();
  const introLinks = React.useMemo(
    () => ({
      acp: <a href={localize("/docs/custom-providers#acp-providers")} className={LINK_CLASS} />,
      plugins: <a href={localize("/docs/plugins/providers")} className={LINK_CLASS} />,
    }),
    [localize],
  );
  return (
    <SiteShell width="default">
      <h1 className="text-3xl font-medium tracking-tight mb-4">{t("agents.title")}</h1>
      <p className="text-lg text-white/70 leading-relaxed max-w-2xl">
        <Trans i18nKey="agents.intro" components={introLinks} />
      </p>
      <a
        href={localize("/docs/supported-providers")}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-3 inline-flex items-center gap-1 text-xs text-extra-muted-foreground transition-colors hover:text-muted-foreground"
      >
        {t("nav.docs")}
        <ExternalLink className="h-3 w-3" />
      </a>

      <div className="mt-16 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        {AGENT_PAGES.map((agent) => (
          <Link
            key={agent.slug}
            to={localize(`/${agent.slug}`)}
            className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 hover:border-white/20 hover:bg-white/[0.05] transition-colors"
          >
            <AgentPageIcon slug={agent.slug} className="h-5 w-5 shrink-0 text-white/80" />
            <span className="min-w-0 text-sm font-medium leading-snug text-white">
              {agent.name}
            </span>
          </Link>
        ))}
      </div>
    </SiteShell>
  );
}
