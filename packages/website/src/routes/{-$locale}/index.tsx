import { createFileRoute } from "@tanstack/react-router";
import { Trans } from "react-i18next";
import { LandingPage } from "~/components/landing-page";
import { getTranslator, routeLocale } from "~/i18n";
import { pageMeta } from "~/meta";

export const Route = createFileRoute("/{-$locale}/")({
  head: ({ params }) => {
    const locale = routeLocale(params);
    const t = getTranslator(locale);
    return pageMeta({
      title: t("home.metaTitle"),
      description: t("home.metaDescription"),
      path: "/",
      locale,
    });
  },
  component: Home,
});

// Trans reads the page language from context when it renders, so these elements can be hoisted.
const TITLE = <Trans i18nKey="home.title" components={{ br: <br /> }} />;
const SUBTITLE = (
  <Trans
    i18nKey="home.subtitle"
    components={{
      mobileBreak: <br className="sm:hidden" />,
      wideSpace: <span className="hidden sm:inline"> </span>,
      br: <br />,
    }}
  />
);

function Home() {
  return <LandingPage title={TITLE} subtitle={SUBTITLE} />;
}
