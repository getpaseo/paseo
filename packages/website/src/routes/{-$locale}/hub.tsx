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
import { DiscordIcon } from "~/components/brand-icons";
import { FAQItem } from "~/components/faq-item";
import {
  HUB_AGENT_HARNESSES,
  HUB_TRIGGER_SOURCES,
  HubArchitectureDiagram,
} from "~/components/hub-flow";
import { PaseoHubLockup, PaseoHubMark, PaseoMark } from "~/components/paseo-brand";
import { SiteShell } from "~/components/site-shell";
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
    <SiteShell width="default">
      <HubHero />
      <div className="mt-20 space-y-24">
        <AutomationsSection />
        <AuthoringSection />
        <InfrastructureSection />
        <AgentsSection />
        <PricingSection plans={plans} />
        <FaqSection />
      </div>
    </SiteShell>
  );
}

function HubHero() {
  const { t } = useTranslation();
  const localize = useLocalizePath();
  return (
    <header className="space-y-6">
      <h1>
        <PaseoHubLockup className="h-9 w-auto text-foreground md:h-10" />
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
    <section className="space-y-8" aria-labelledby="automations-heading">
      <div className="space-y-2">
        <h2 id="automations-heading" className="text-2xl font-medium tracking-tight">
          {t("hub.automations.title")}
        </h2>
        <p className="max-w-2xl leading-relaxed text-white/70">
          {t("hub.automations.description")}
        </p>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {HUB_TRIGGER_SOURCES.map(({ id, Icon }) => (
          <div
            key={id}
            className="flex items-start gap-3.5 rounded-xl border border-white/10 bg-white/[0.025] p-4"
          >
            <span className="mt-0.5 shrink-0 text-white/80">
              <Icon className="h-5 w-5" />
            </span>
            <div className="min-w-0 space-y-1">
              <h3 className="text-sm font-medium text-white/90">{t(`hub.sources.${id}.name`)}</h3>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t(`hub.sources.${id}.description`)}
              </p>
            </div>
          </div>
        ))}
      </div>
      <ConversationDemo />
    </section>
  );
}

const DEMO_ISSUES = [
  { id: "#2811", title: "Terminal output drops under load" },
  { id: "#2804", title: "Relay reconnect loop on Android after sleep" },
  { id: "#2799", title: "Worktree cleanup leaves stale branches" },
];

const DEMO_COMPONENTS = {
  mention: <Mention />,
  host: <span className="font-mono text-white/50" />,
  pr: <span className="text-white/80 underline decoration-white/20" />,
};

function ConversationDemo() {
  const { t } = useTranslation();
  return (
    <figure className="space-y-3">
      <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.02]">
        <div className="flex items-center gap-2 border-b border-white/10 bg-white/[0.03] px-5 py-3">
          <DiscordIcon className="h-4 w-4 text-white/40" />
          <span className="font-mono text-xs text-white/50">#engineering</span>
        </div>
        <div className="space-y-5 p-5">
          <DemoMessage author="moboudra" time="09:41">
            <p>
              <Trans i18nKey="hub.demo.showIssues" components={DEMO_COMPONENTS} />
            </p>
          </DemoMessage>

          <DemoMessage author="paseo-bot" time="09:41" bot>
            <p>{t("hub.demo.issuesOpen")}</p>
            <ul className="space-y-1">
              {DEMO_ISSUES.map((issue) => (
                <li key={issue.id} className="flex gap-2">
                  <span className="font-mono text-white/40">{issue.id}</span>
                  <span>{issue.title}</span>
                </li>
              ))}
            </ul>
          </DemoMessage>

          <DemoMessage author="moboudra" time="09:43">
            <p>
              <Trans i18nKey="hub.demo.createPr" components={DEMO_COMPONENTS} />
            </p>
          </DemoMessage>

          <DemoMessage author="paseo-bot" time="09:48" bot>
            <p>
              <Trans i18nKey="hub.demo.ranOn" components={DEMO_COMPONENTS} />
            </p>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <span className="rounded-full bg-emerald-400/10 px-2.5 py-1 text-xs text-emerald-300">
                {t("hub.demo.filesChanged")}
              </span>
              <span className="rounded-full border border-white/10 px-2.5 py-1 text-xs text-white/45">
                {t("hub.demo.testsPassed")}
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/[0.05] px-2.5 py-1 text-xs text-white/75">
                <PaseoMark className="h-3 w-3 text-white/85" />
                {t("hub.demo.openInPaseo")}
              </span>
            </div>
          </DemoMessage>
        </div>
      </div>
      <figcaption className="text-sm text-muted-foreground">{t("hub.demo.caption")}</figcaption>
    </figure>
  );
}

function Mention() {
  return <span className="rounded bg-indigo-400/15 px-1 py-0.5 text-indigo-200">@paseo-bot</span>;
}

function DemoMessage({
  author,
  time,
  bot,
  children,
}: {
  author: string;
  time: string;
  bot?: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex gap-3">
      <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/[0.06]">
        {bot ? (
          <PaseoHubMark className="h-5 w-5 text-white" />
        ) : (
          <span className="text-xs font-medium text-white/60">M</span>
        )}
      </div>
      <div className="min-w-0 space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-white/90">{author}</span>
          {bot ? (
            <span className="rounded bg-indigo-400/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-indigo-200">
              {t("hub.demo.bot")}
            </span>
          ) : null}
          <span className="text-xs text-white/25">{time}</span>
        </div>
        <div className="space-y-2 text-sm leading-relaxed text-white/70">{children}</div>
      </div>
    </div>
  );
}

const DASHBOARD_ITEMS = ["triggers", "validation", "activity"] as const;

function AuthoringSection() {
  const { t } = useTranslation();
  const localize = useLocalizePath();
  return (
    <section className="space-y-8" aria-labelledby="authoring-heading">
      <div className="space-y-2">
        <h2 id="authoring-heading" className="text-2xl font-medium tracking-tight">
          {t("hub.authoring.title")}
        </h2>
        <p className="max-w-2xl leading-relaxed text-white/70">{t("hub.authoring.description")}</p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <AuthoringDashboardCard docsHref={localize("/docs/hub/configuration")} />
        <AuthoringYamlCard />
      </div>
    </section>
  );
}

function AuthoringDashboardCard({ docsHref }: { docsHref: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col justify-between gap-6 rounded-2xl border border-white/10 bg-white/[0.02] p-6">
      <div className="space-y-5">
        <div className="flex items-center gap-2.5">
          <SlidersHorizontal className="h-4 w-4 text-extra-muted-foreground" strokeWidth={1.5} />
          <h3 className="text-base font-medium text-white/90">
            {t("hub.authoring.dashboardTitle")}
          </h3>
        </div>
        <p className="text-sm leading-relaxed text-white/65">
          {t("hub.authoring.dashboardDescription")}
        </p>
        <ul className="space-y-3 border-t border-white/10 pt-4">
          {DASHBOARD_ITEMS.map((item) => (
            <li key={item} className="flex items-start gap-2.5 text-sm">
              <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-emerald-300" />
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
          className="inline-flex items-center gap-1.5 text-sm text-white/70 transition-colors hover:text-white"
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
    <div className="flex flex-col overflow-hidden rounded-2xl border border-white/10 bg-black/25">
      <div className="flex items-center justify-between border-b border-white/10 bg-white/[0.03] px-5 py-3">
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
        <span className="block text-emerald-300/80">{"    Answer the thread, then call"}</span>
        <span className="block text-emerald-300/80">{"    hub.finish_execution."}</span>
      </pre>
      <div className="space-y-1 border-t border-white/10 bg-white/[0.02] px-5 py-3.5 font-mono text-xs text-white/65">
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
    <section className="space-y-8" aria-labelledby="infrastructure-heading">
      <div className="space-y-2">
        <h2 id="infrastructure-heading" className="text-2xl font-medium tracking-tight">
          {t("hub.shape.title")}
        </h2>
        <p className="max-w-2xl leading-relaxed text-white/70">{t("hub.shape.description")}</p>
      </div>

      <HubArchitectureDiagram />

      <div className="grid gap-4 md:grid-cols-3">
        {GUARDRAILS.map(({ key, Icon }) => (
          <div
            key={key}
            className="rounded-xl border border-white/10 bg-white/[0.025] p-5 space-y-2.5"
          >
            <div className="flex items-center gap-2.5">
              <Icon className="h-4 w-4 shrink-0 text-extra-muted-foreground" strokeWidth={1.5} />
              <h3 className="text-sm font-medium text-white/90">
                {t(`hub.guardrails.${key}Title`)}
              </h3>
            </div>
            <p className="text-sm leading-relaxed text-white/55">
              <Trans
                i18nKey={`hub.guardrails.${key}Description`}
                components={GUARDRAIL_CODE_COMPONENTS}
              />
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

function AgentsSection() {
  const { t } = useTranslation();
  return (
    <section className="space-y-6" aria-labelledby="agents-heading">
      <div className="space-y-2">
        <h2 id="agents-heading" className="text-2xl font-medium tracking-tight">
          {t("hub.agents.title")}
        </h2>
        <p className="max-w-2xl leading-relaxed text-white/70">{t("hub.agents.description")}</p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {HUB_AGENT_HARNESSES.map(({ name, Icon }) => (
          <div
            key={name}
            className="flex items-center gap-2.5 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3"
          >
            <span className="text-white/80">
              <Icon className="h-5 w-5" />
            </span>
            <span className="text-sm font-medium">{name}</span>
          </div>
        ))}
      </div>
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
      <section className="space-y-6" aria-labelledby="pricing-heading">
        <div className="space-y-2">
          <h2 id="pricing-heading" className="text-2xl font-medium tracking-tight">
            {t("hub.pricing.title")}
          </h2>
          <p className="max-w-2xl leading-relaxed text-white/70">{t("hub.pricing.unavailable")}</p>
        </div>
        <a
          href={localize("/docs/hub/self-hosting")}
          className="inline-block rounded-md border border-white/15 px-4 py-2 text-sm font-medium text-white/80 transition-colors hover:border-white/25 hover:text-white"
        >
          {t("hub.pricing.selfHost")}
        </a>
      </section>
    );
  }

  return (
    <section className="space-y-8" aria-labelledby="pricing-heading">
      <div className="space-y-2">
        <h2 id="pricing-heading" className="text-2xl font-medium tracking-tight">
          {t("hub.pricing.title")}
        </h2>
        <p className="max-w-2xl leading-relaxed text-white/70">{t("hub.pricing.seatNote")}</p>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
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
      </div>
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
  if (seats === null) return t("hub.pricing.unlimitedUnits", { unit });
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
      className={`flex flex-col rounded-2xl border p-6 ${featured ? "border-white/25 bg-white/[0.06]" : "border-white/10 bg-white/[0.02]"}`}
    >
      <h3 className="text-xl font-medium">{name}</h3>
      <div className="mt-6 flex items-end gap-2">
        <span className="text-4xl font-medium tracking-tight">{price}</span>
        <span className="mb-1 inline-flex items-center gap-1 text-sm text-white/45">
          {priceQualifier}
          {priceTooltip !== null ? <InfoTip text={priceTooltip} /> : null}
        </span>
      </div>
      {features.length > 0 ? (
        <ul className="mt-6 grid flex-1 content-start gap-3 text-sm text-white/70">
          {features.map((feature) => (
            <li key={feature.key} className="flex items-start gap-2.5">
              <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-emerald-300" />
              <span>{feature.label}</span>
              {feature.tooltip !== null ? <InfoTip text={feature.tooltip} /> : null}
            </li>
          ))}
        </ul>
      ) : null}
      <a
        href={actionHref}
        className={`mt-8 rounded-md px-4 py-2 text-center text-sm font-medium transition-colors ${featured ? "bg-white text-black hover:bg-white/90" : "border border-white/15 text-white/80 hover:border-white/25 hover:text-white"}`}
      >
        {actionLabel}
      </a>
    </article>
  );
}

function InfoTip({ text }: { text: string }) {
  return (
    <span className="group relative inline-flex shrink-0" tabIndex={0}>
      <CircleHelp aria-label={text} className="size-3.5 text-white/35" />
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 hidden w-56 -translate-x-1/2 rounded-md border border-white/10 bg-[#17201f] px-3 py-2 text-xs leading-relaxed text-white/75 shadow-xl group-hover:block group-focus:block"
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
    <section className="space-y-6" aria-labelledby="faq-heading">
      <h2 id="faq-heading" className="text-2xl font-medium tracking-tight">
        {t("hub.faq.title")}
      </h2>
      <div className="space-y-6">
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
