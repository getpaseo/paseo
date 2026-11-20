import { useTranslation } from "react-i18next";
import { LandingPage } from "~/components/landing-page";
import { type AgentPageSlug, getAgentPage } from "~/data/agent-pages";
import { getTranslator, routeLocale } from "~/i18n";
import { pageMeta } from "~/meta";

export function agentRouteOptions(slug: AgentPageSlug) {
  return {
    head: ({ params }: { params: { locale?: string } }) => {
      const locale = routeLocale(params);
      const page = getAgentPage(slug, getTranslator(locale));
      return pageMeta({
        title: page.metaTitle,
        description: page.metaDescription,
        path: `/${slug}`,
        locale,
      });
    },
    component: function AgentLandingPage() {
      const { t } = useTranslation();
      const page = getAgentPage(slug, t);
      return <LandingPage title={page.title} subtitle={page.subtitle} />;
    },
  };
}
