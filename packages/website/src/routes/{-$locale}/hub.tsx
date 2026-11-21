import { createFileRoute } from "@tanstack/react-router";
import {
  ArrowRight,
  Check,
  CircleHelp,
  Filter,
  ShieldCheck,
  SlidersHorizontal,
  Users,
} from "lucide-react";
import * as React from "react";
import type { ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { FAQItem } from "~/components/faq-item";
import { HubAutomationsShowcase } from "~/components/hub-automations";
import { HUB_AGENT_HARNESSES, HubArchitectureDiagram } from "~/components/hub-flow";
import { ChapterBand, HairlineGrid, PageHeaderBand, SectionOpener } from "~/components/page-frame";
import { PaseoHubLockup } from "~/components/paseo-brand";
import { SiteFooter } from "~/components/site-footer";
import {
  billingUnitLabel,
  formatPlanPrice,
  getHubPlans,
  planPriceQualifier,
  type HubPlanOffer,
  type HubPlans,
} from "~/hub-plans";
import {
  formatNumber,
  getTranslator,
  type Locale,
  routeLocale,
  useLocale,
  useLocalizePath,
} from "~/i18n";
import { pageMeta } from "~/meta";

export const Route = createFileRoute("/{-$locale}/hub")({
  head: ({ params }) => {
    const locale = routeLocale(params);
    const t = getTranslator(locale);
    return pageMeta({
      title: t("hub.metaTitle"),
      description: t("hub.metaDescription"),
      path: "/hub",
      locale,
    });
  },
  loader: async () => {
    try {
      return { plans: await getHubPlans() };
    } catch {
      return { plans: null };
    }
  },
  component: Hub,
});

const HOSTED_HUB_URL = "https://hub.paseo.sh";

const LINK_CLASS = "underline hover:text-white/80";
const PRIMARY_CTA_CLASS =
  "inline-flex items-center justify-center gap-2 rounded-lg bg-foreground px-4 py-2.5 text-sm font-medium text-background transition-colors hover:bg-foreground/90";
const SECONDARY_CTA_CLASS =
  "inline-flex items-center justify-center gap-2 rounded-lg border border-white/12 px-4 py-2.5 text-sm text-white/85 transition-colors hover:bg-white/10 hover:text-white";

function Hub() {
  const { plans } = Route.useLoaderData();
  return (
    <div className="min-h-screen bg-background">
      <PageHeaderBand />
      <main>
        <ChapterBand spacing="hero" ruled={false} ticks={false} framed={false}>
          <HubHero />
        </ChapterBand>

        <ChapterBand spacing="section">
          <AutomationsSection />
        </ChapterBand>

        <ChapterBand spacing="section">
          <AuthoringSection />
        </ChapterBand>

        <ChapterBand spacing="section">
          <InfrastructureSection />
        </ChapterBand>

        <ChapterBand spacing="compact">
          <AgentsSection />
        </ChapterBand>

        <ChapterBand spacing="section" tint="subtle">
          <PricingSection plans={plans} />
        </ChapterBand>

        <ChapterBand spacing="section">
          <FaqSection />
        </ChapterBand>
      </main>
      <SiteFooter width="default" />
    </div>
  );
}

function HubHero() {
  const { t } = useTranslation();
  const localize = useLocalizePath();
  return (
    <header className="space-y-6">
      <h1>
        <PaseoHubLockup size="display" className="h-10 w-auto text-foreground md:h-12" />
        <span className="sr-only">{t("hub.title")}</span>
      </h1>
      <p className="max-w-2xl text-lg leading-relaxed text-white/70">{t("hub.intro")}</p>
      <div className="flex flex-wrap items-center gap-3 pt-1">
        <a href={HOSTED_HUB_URL} className={PRIMARY_CTA_CLASS}>
          {t("hub.hero.getStarted")}
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </a>
        <a href={localize("/docs/hub")} className={SECONDARY_CTA_CLASS}>
          {t("hub.hero.selfHost")}
        </a>
      </div>
      <p className="text-sm text-white/45">{t("hub.runIt")}</p>
    </header>
  );
}

function AutomationsSection() {
  const { t } = useTranslation();
  return (
    <section aria-labelledby="automations-heading">
      <SectionOpener
        headingId="automations-heading"
        title={t("hub.automations.title")}
        description={t("hub.automations.description")}
      />
      <HubAutomationsShowcase />
    </section>
  );
}

const DASHBOARD_ITEMS = ["triggers", "validation", "activity"] as const;

function AuthoringSection() {
  const { t } = useTranslation();
  const localize = useLocalizePath();
  return (
    <section aria-labelledby="authoring-heading">
      <SectionOpener
        headingId="authoring-heading"
        title={t("hub.authoring.title")}
        description={t("hub.authoring.description")}
      />

      <HairlineGrid columns="2">
        <AuthoringDashboardCard docsHref={localize("/docs/hub/configuration")} />
        <AuthoringYamlCard />
      </HairlineGrid>
    </section>
  );
}

function AuthoringDashboardCard({ docsHref }: { docsHref: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col justify-between gap-6 bg-background p-6">
      <div className="space-y-5">
        <div className="flex items-center gap-2.5">
          <SlidersHorizontal className="h-4 w-4 text-accent-text" strokeWidth={1.5} />
          <h3 className="text-base font-medium text-white/90">
            {t("hub.authoring.dashboardTitle")}
          </h3>
        </div>
        <p className="text-sm leading-relaxed text-white/65">
          {t("hub.authoring.dashboardDescription")}
        </p>
        <ul className="space-y-3 border-t border-white/[0.08] pt-4">
          {DASHBOARD_ITEMS.map((item) => (
            <li key={item} className="flex items-start gap-2.5 text-sm">
              <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-accent-text" />
              <span className="text-white/75">
                <span className="font-medium text-white/90">{t(`hub.authoring.${item}Label`)}</span>{" "}
                <span className="text-white/55">{t(`hub.authoring.${item}Text`)}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <a
          href={docsHref}
          className="inline-flex items-center gap-1.5 text-sm text-white/75 transition-colors hover:text-accent-text"
        >
          {t("hub.authoring.docsLink")}
          <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
        </a>
      </div>
    </div>
  );
}

function AuthoringYamlCard() {
  return (
    <div className="flex flex-col bg-[#0c1110]">
      <div className="flex items-center justify-between border-b border-white/[0.08] bg-white/[0.02] px-5 py-3">
        <span className="font-mono text-xs text-white/70">.paseo/triggers/slack-help.yml</span>
        <span className="rounded border border-white/10 px-1.5 py-0.5 font-mono text-[10px] text-white/40">
          YAML
        </span>
      </div>
      <pre className="flex-1 overflow-x-auto p-5 font-mono text-[12px] leading-6 text-white/75">
        <YamlLine k="name" v="slack-help" />
        <YamlKey k="on" />
        <YamlKey k="slack.mention" indent={2} />
        <YamlLine k="connection" v="acme-slack" indent={4} />
        <YamlKey k="filters" indent={4} />
        <YamlLine k="from_users" v="[U01234567]" indent={6} />
        <YamlKey k="run" />
        <YamlKey k="target" indent={2} />
        <YamlLine k="daemon" v="devbox" indent={4} />
        <YamlLine k="cwd" v="/workspace/app" indent={4} />
        <YamlKey k="agent" indent={2} />
        <YamlLine k="provider" v="codex" indent={4} />
        <YamlLine k="mode" v="full-access" indent={4} />
        <YamlLine k="continuation" v="{ mode: conversation }" indent={2} />
        <YamlLine k="prompt" v="|" indent={2} />
        <span className="block text-emerald-300/80">
          {"    Answer with hub.reply, then call hub.finish_execution."}
        </span>
        <span className="block text-emerald-300/80">{"    <user-prompt>"}</span>
        <span className="block text-emerald-300/80">{"    ${{ paseo.prompt }}"}</span>
        <span className="block text-emerald-300/80">{"    </user-prompt>"}</span>
        <YamlKey k="outputs" indent={2} />
        <YamlKey k="slack.reply" indent={4} />
        <YamlLine k="max" v="1" indent={6} />
        <YamlLine k="required" v="true" indent={6} />
      </pre>
      <div className="space-y-1 border-t border-white/[0.08] bg-white/[0.02] px-5 py-3.5 font-mono text-xs text-white/65">
        <div>
          <span className="select-none text-white/30">$ </span>
          <span className="text-white/90">paseo hub deploy</span>{" "}
          <span className="text-sky-300/80">--dry-run</span>
        </div>
        <div>
          <span className="select-none text-white/30">$ </span>
          <span className="text-white/90">paseo hub deploy</span>
        </div>
      </div>
    </div>
  );
}

function YamlKey({ k, indent = 0 }: { k: string; indent?: number }) {
  return (
    <span className="block">
      {" ".repeat(indent)}
      <span className="text-sky-300/80">{k}</span>
      <span className="text-white/35">:</span>
    </span>
  );
}

function YamlLine({ k, v, indent = 0 }: { k: string; v: string; indent?: number }) {
  return (
    <span className="block">
      {" ".repeat(indent)}
      <span className="text-sky-300/80">{k}</span>
      <span className="text-white/35">: </span>
      <span className="text-emerald-300/80">{v}</span>
    </span>
  );
}

const GUARDRAILS = [
  { key: "optIn", Icon: ShieldCheck },
  { key: "scoped", Icon: Filter },
  { key: "visibility", Icon: Users },
] as const;

const GUARDRAIL_CODE_COMPONENTS = {
  code: <code className="font-mono text-xs text-white/80" />,
};

function InfrastructureSection() {
  const { t } = useTranslation();
  return (
    <section aria-labelledby="infrastructure-heading">
      <SectionOpener
        eyebrow={t("hub.eyebrows.architecture")}
        headingId="infrastructure-heading"
        title={t("hub.shape.title")}
        description={t("hub.shape.description")}
      />

      <div className="space-y-6">
        <HubArchitectureDiagram />

        <HairlineGrid columns="3">
          {GUARDRAILS.map(({ key, Icon }) => (
            <div key={key} className="space-y-2.5 bg-background p-6">
              <div className="flex items-center gap-2.5">
                <Icon className="h-4 w-4 shrink-0 text-accent-text" strokeWidth={1.5} />
                <h3 className="text-sm font-medium text-white/90">
                  {t(`hub.guardrails.${key}Title`)}
                </h3>
              </div>
              <p className="text-sm leading-relaxed text-white/60">
                <Trans
                  i18nKey={`hub.guardrails.${key}Description`}
                  components={GUARDRAIL_CODE_COMPONENTS}
                />
              </p>
            </div>
          ))}
        </HairlineGrid>
      </div>
    </section>
  );
}

function AgentsSection() {
  const { t } = useTranslation();
  return (
    <section aria-labelledby="agents-heading">
      <SectionOpener
        headingId="agents-heading"
        title={t("hub.agents.title")}
        description={t("hub.agents.description")}
      />
      <HairlineGrid columns="3">
        {HUB_AGENT_HARNESSES.map(({ name, Icon }) => (
          <div key={name} className="flex items-center gap-3 bg-background px-5 py-4">
            <span className="text-white/80">
              <Icon className="h-5 w-5" />
            </span>
            <span className="text-sm font-medium text-white/90">{name}</span>
          </div>
        ))}
      </HairlineGrid>
    </section>
  );
}

interface PlanFeature {
  key: string;
  label: ReactNode;
  tooltip: string | null;
}

const PRICING_CODE_COMPONENTS = {
  code: <code className="font-mono text-xs text-white/85" />,
};

function PricingSection({ plans }: { plans: HubPlans | null }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const localize = useLocalizePath();
  const selfHostedFeatures = React.useMemo<readonly PlanFeature[]>(
    () => [
      {
        key: "operate-hub",
        label: <Trans i18nKey="hub.pricing.operateHub" components={PRICING_CODE_COMPONENTS} />,
        tooltip: null,
      },
      {
        key: "all-sources",
        label: t("hub.pricing.allSources"),
        tooltip: null,
      },
      {
        key: "own-apps",
        label: t("hub.pricing.ownApps"),
        tooltip: null,
      },
      {
        key: "open-source",
        label: t("hub.pricing.openSourceFeature"),
        tooltip: null,
      },
    ],
    [t],
  );

  if (plans === null) {
    return (
      <section aria-labelledby="pricing-heading">
        <SectionOpener
          eyebrow={t("hub.eyebrows.pricing")}
          headingId="pricing-heading"
          title={t("hub.pricing.title")}
          description={t("hub.pricing.unavailable")}
        />
        <a href={localize("/docs/hub/self-hosting")} className={SECONDARY_CTA_CLASS}>
          {t("hub.pricing.selfHost")}
        </a>
      </section>
    );
  }

  return (
    <section aria-labelledby="pricing-heading">
      <SectionOpener
        eyebrow={t("hub.eyebrows.pricing")}
        headingId="pricing-heading"
        title={t("hub.pricing.title")}
        description={t("hub.pricing.seatNote")}
      />
      <HairlineGrid columns="3" clipContents={false}>
        <PlanCard
          name={t("hub.pricing.selfHosted")}
          price={t("hub.pricing.free")}
          priceQualifier={t("hub.pricing.openSource")}
          priceTooltip={null}
          features={selfHostedFeatures}
          actionHref={localize("/docs/hub/self-hosting")}
          actionLabel={t("hub.pricing.selfHost")}
        />
        <PlanCard
          name={plans.free.name}
          price={formatPlanPrice(plans.free.price, locale)}
          priceQualifier={planPriceQualifier(plans.free, t)}
          priceTooltip={plans.free.price.tooltip}
          features={planFeatures(plans.free, t, locale)}
          actionHref={HOSTED_HUB_URL}
          actionLabel={t("hub.pricing.getStarted")}
        />
        <PlanCard
          name={plans.paid.name}
          price={formatPlanPrice(plans.paid.price, locale)}
          priceQualifier={planPriceQualifier(plans.paid, t)}
          priceTooltip={plans.paid.price.tooltip}
          features={planFeatures(plans.paid, t, locale)}
          actionHref={HOSTED_HUB_URL}
          actionLabel={t("hub.pricing.getStarted")}
          featured
        />
      </HairlineGrid>
    </section>
  );
}

/**
 * The figures the plan includes, ahead of the prose the catalog wrote for it. Hub serves plan
 * names, feature labels and tooltips in English, so those show as the catalog wrote them, except
 * the trigger summary key which maps to the current source list on this site.
 */
function planFeatures(plan: HubPlanOffer, t: TFunction, locale: Locale): readonly PlanFeature[] {
  return [
    {
      key: "included-executions",
      label: formatAllowance(plan.included.executionsPerMonth, t, locale),
      tooltip: null,
    },
    {
      key: "included-seats",
      label: formatSeats(plan.included.seats, billingUnitLabel(plan, t), t, locale),
      tooltip: null,
    },
    ...plan.features.map((feature) => ({
      ...feature,
      label: feature.key === "managed-triggers" ? t("hub.pricing.managedSources") : feature.label,
    })),
  ];
}

function formatAllowance(executionsPerMonth: number | null, t: TFunction, locale: Locale): string {
  if (executionsPerMonth === null) return t("hub.pricing.unlimitedRuns");
  return t("hub.pricing.runsPerMonth", {
    count: executionsPerMonth,
    value: formatNumber(executionsPerMonth, locale),
  });
}

function formatSeats(seats: number | null, unit: string, t: TFunction, locale: Locale): string {
  if (seats === null) return t("hub.pricing.noSeatCap");
  return t("hub.pricing.units", { count: seats, value: formatNumber(seats, locale), unit });
}

function PlanCard({
  name,
  price,
  priceQualifier,
  priceTooltip,
  features,
  actionHref,
  actionLabel,
  featured = false,
}: {
  name: string;
  price: string;
  priceQualifier: string;
  priceTooltip: string | null;
  features: readonly PlanFeature[];
  actionHref: string;
  actionLabel: string;
  featured?: boolean;
}) {
  return (
    <article
      className={`flex flex-col p-6 first:rounded-t-[inherit] last:rounded-b-[inherit] md:p-7 md:first:rounded-tr-none md:first:rounded-bl-[inherit] md:last:rounded-tr-[inherit] md:last:rounded-bl-none ${featured ? "bg-brand-green/[0.08]" : "bg-background"}`}
    >
      <h3 className="text-lg font-medium text-white/90">{name}</h3>
      <div className="relative mt-5 flex items-end gap-2">
        <span className="text-4xl font-medium tracking-tight">{price}</span>
        <span className="mb-1 inline-flex items-center gap-1 text-sm text-white/45">
          {priceQualifier}
          {priceTooltip !== null ? <InfoTip text={priceTooltip} /> : null}
        </span>
      </div>
      {features.length > 0 ? (
        <ul className="mt-6 grid flex-1 content-start gap-3 text-sm text-white/70">
          {features.map((feature) => (
            <li key={feature.key} className="relative flex items-start gap-2.5">
              <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-accent-text" />
              <span>{feature.label}</span>
              {feature.tooltip !== null ? <InfoTip text={feature.tooltip} /> : null}
            </li>
          ))}
        </ul>
      ) : null}
      <a
        href={actionHref}
        className={`mt-8 rounded-lg px-4 py-2.5 text-center text-sm font-medium transition-colors ${
          featured
            ? "bg-foreground text-background hover:bg-foreground/90"
            : "border border-white/15 text-white/85 hover:border-white/25 hover:bg-white/[0.04] hover:text-white"
        }`}
      >
        {actionLabel}
      </a>
    </article>
  );
}

function InfoTip({ text }: { text: string }) {
  return (
    <span className="group inline-flex shrink-0" tabIndex={0}>
      <CircleHelp aria-label={text} className="size-3.5 text-white/35" />
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-0 z-10 mb-2 hidden w-full max-w-56 rounded-md border border-white/10 bg-[#17201f] px-3 py-2 text-xs leading-relaxed text-white/75 shadow-xl group-hover:block group-focus:block"
      >
        {text}
      </span>
    </span>
  );
}

const SIMPLE_FAQ_ENTRIES = ["need"] as const;
const LATER_FAQ_ENTRIES = ["move", "agents"] as const;

function FaqSection() {
  const { t } = useTranslation();
  const localize = useLocalizePath();
  const links = React.useMemo(
    () => ({
      code: <code className="font-mono text-xs text-white/80" />,
      github: <a href="https://github.com/getpaseo/hub" className={LINK_CLASS} />,
      guide: <a href={localize("/docs/hub/self-hosting")} className={LINK_CLASS} />,
      hosted: <a href={HOSTED_HUB_URL} className={LINK_CLASS} />,
    }),
    [localize],
  );
  return (
    <section
      aria-labelledby="faq-heading"
      className="grid items-start gap-10 lg:grid-cols-[minmax(0,17rem)_minmax(0,1fr)] lg:gap-16"
    >
      <SectionOpener
        headingId="faq-heading"
        title={t("hub.faq.title")}
        className="mb-0 self-start"
      />
      <div className="divide-y divide-white/[0.08] border-y border-white/[0.08]">
        <FAQItem question={t("hub.faq.whatQuestion")}>{t("hub.faq.whatAnswer")}</FAQItem>
        <FAQItem question={t("hub.faq.separateQuestion")}>
          <p>{t("hub.faq.separateAnswer1")}</p>
          <p>{t("hub.faq.separateAnswer2")}</p>
        </FAQItem>
        <FAQItem question={t("hub.faq.selfHostQuestion")}>
          <Trans i18nKey="hub.faq.selfHostAnswer" components={links} />
        </FAQItem>
        {SIMPLE_FAQ_ENTRIES.map((entry) => (
          <FAQItem key={entry} question={t(`hub.faq.${entry}Question`)}>
            {t(`hub.faq.${entry}Answer`)}
          </FAQItem>
        ))}
        <FAQItem question={t("hub.faq.hostedQuestion")}>
          <Trans i18nKey="hub.faq.hostedAnswer" components={links} />
        </FAQItem>
        <FAQItem question={t("hub.faq.codeQuestion")}>
          <Trans i18nKey="hub.faq.codeAnswer" components={links} />
        </FAQItem>
        {LATER_FAQ_ENTRIES.map((entry) => (
          <FAQItem key={entry} question={t(`hub.faq.${entry}Question`)}>
            {t(`hub.faq.${entry}Answer`)}
          </FAQItem>
        ))}
        <FAQItem question={t("hub.faq.plannedQuestion")}>
          <p>{t("hub.faq.plannedIntro")}</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>{t("hub.faq.plannedProvisioning")}</li>
            <li>{t("hub.faq.plannedSharing")}</li>
            <li>{t("hub.faq.plannedIntegrations")}</li>
          </ul>
        </FAQItem>
        <FAQItem question={t("hub.faq.accessQuestion")}>
          <Trans i18nKey="hub.faq.accessAnswer" components={links} />
        </FAQItem>
      </div>
    </section>
  );
}
