import { useLoaderData } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { LandingPage } from "~/components/landing-page";
import { type AgentPageSlug, getAgentPage } from "~/data/agent-pages";
import { getTranslator, routeLocale } from "~/i18n";
import { pageMeta } from "~/meta";
import { getPluginCount } from "~/plugins";

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
    loader: async () => ({ pluginCount: await getPluginCount() }),
    component: function AgentLandingPage() {
      const { t } = useTranslation();
      const data = useLoaderData({ strict: false }) as { pluginCount?: number | null } | undefined;
      const page = getAgentPage(slug, t);
      return (
        <LandingPage
          title={page.title}
          subtitle={page.subtitle}
          pluginCount={data?.pluginCount ?? null}
        />
      );
    },
  };
}
