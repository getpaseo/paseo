import { LandingPage } from "~/components/landing-page";
import { getAgentPage } from "~/data/agent-pages";
import { pageMeta } from "~/meta";

export function agentRouteOptions(slug: string) {
  const page = getAgentPage(slug);
  return {
    head: () => pageMeta(page.metaTitle, page.metaDescription, `/${slug}`),
    component: function AgentLandingPage() {
      return <LandingPage title={page.title} subtitle={page.subtitle} />;
    },
  };
}
