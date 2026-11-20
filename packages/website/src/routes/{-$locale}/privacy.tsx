import { createFileRoute } from "@tanstack/react-router";
import { LegalPage } from "~/components/legal-page";
import { routeLocale } from "~/i18n";
import { getLegalDocument } from "~/legal";
import { pageMeta } from "~/meta";

export const Route = createFileRoute("/{-$locale}/privacy")({
  head: ({ params }) => {
    const locale = routeLocale(params);
    const document = getLegalDocument("privacy", locale);
    return pageMeta({
      title: `${document.title} - Paseo`,
      description: document.description,
      path: "/privacy",
      locale,
    });
  },
  component: () => <LegalPage name="privacy" />,
});
