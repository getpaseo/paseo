import { createFileRoute } from "@tanstack/react-router";
import { SiteShell } from "~/components/site-shell";
import { SponsorPaseoSection, SponsorSpotSection } from "~/components/sponsorship";
import { getTranslator, routeLocale } from "~/i18n";
import { pageMeta } from "~/meta";

export const Route = createFileRoute("/{-$locale}/sponsor")({
  head: ({ params }) => {
    const locale = routeLocale(params);
    const t = getTranslator(locale);
    return pageMeta({
      title: t("sponsor.metaTitle"),
      description: t("sponsor.metaDescription"),
      path: "/sponsor",
      locale,
    });
  },
  component: Sponsor,
});

function Sponsor() {
  return (
    <SiteShell width="default">
      <div className="space-y-24">
        <SponsorPaseoSection />
        <SponsorSpotSection />
      </div>
    </SiteShell>
  );
}
