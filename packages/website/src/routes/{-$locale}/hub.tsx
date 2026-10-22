import { createFileRoute } from "@tanstack/react-router";
import { Check, CircleHelp } from "lucide-react";
import * as React from "react";
import type { ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  ClaudeCodeIcon,
  CodexIcon,
  CursorIcon,
  OpenCodeIcon,
  PiIcon,
} from "~/components/agent-icons";
import { DiscordIcon, GitHubIcon, SlackIcon } from "~/components/brand-icons";
import { AGENT_PAGES } from "~/data/agent-pages";
import { FAQItem } from "~/components/faq-item";
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

function Hub() {
  const { t } = useTranslation();
  const { plans } = Route.useLoaderData();
  return (
    <SiteShell width="default">
      <h1 className="text-3xl font-medium tracking-tight mb-4">{t("hub.title")}</h1>
      <p className="text-lg text-white/70 leading-relaxed max-w-2xl">{t("hub.intro")}</p>
      <p className="text-white/40 text-sm mt-3">{t("hub.runIt")}</p>

      <div className="space-y-20 mt-16">
        <Triggers />
        <Agents />
        <Shape />
        <Pricing plans={plans} />
        <FaqSection />
      </div>
    </SiteShell>
  );
}

interface PlanFeature {
  key: string;
  label: string;
  tooltip: string | null;
}

const SELF_HOSTED_FEATURES = [
  { key: "operate-hub", labelKey: "operateHub" },
  { key: "own-apps", labelKey: "ownApps" },
  { key: "open-source", labelKey: "openSourceFeature" },
] as const;

function Pricing({ plans }: { plans: HubPlans | null }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const localize = useLocalizePath();
  const selfHostedFeatures = React.useMemo(
    () =>
      SELF_HOSTED_FEATURES.map((feature) => ({
        key: feature.key,
        label: t(`hub.pricing.${feature.labelKey}`),
        tooltip: null,
      })),
    [t],
  );
  if (plans === null) {
    return (
      <section className="space-y-6" aria-labelledby="pricing-heading">
        <div className="space-y-2">
          <h2 id="pricing-heading" className="text-xl font-medium">
            {t("hub.pricing.title")}
          </h2>
          <p className="max-w-2xl leading-relaxed text-white/70">{t("hub.pricing.unavailable")}</p>
        </div>
        <a
          href={localize("/docs/hub/quickstart")}
          className="inline-block rounded-md border border-white/15 px-4 py-2 text-sm font-medium text-white/80 transition-colors hover:border-white/25 hover:text-white"
        >
          {t("hub.pricing.selfHost")}
        </a>
      </section>
    );
  }

  return (
    <section className="space-y-6" aria-labelledby="pricing-heading">
      <h2 id="pricing-heading" className="text-xl font-medium">
        {t("hub.pricing.title")}
      </h2>
      <div className="grid gap-4 md:grid-cols-3">
        <PlanCard
          name={t("hub.pricing.selfHosted")}
          price={t("hub.pricing.free")}
          priceQualifier={t("hub.pricing.openSource")}
          priceTooltip={null}
          features={selfHostedFeatures}
          actionHref={localize("/docs/hub/quickstart")}
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
 * names, feature labels and tooltips in English, so those show as the catalog wrote them.
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
    ...plan.features,
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
          {priceTooltip !== null && <InfoTip text={priceTooltip} />}
        </span>
      </div>
      {features.length > 0 && (
        <ul className="mt-6 grid flex-1 content-start gap-3 text-sm text-white/70">
          {features.map((feature) => (
            <li key={feature.key} className="flex items-start gap-2.5">
              <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-emerald-300" />
              <span>{feature.label}</span>
              {feature.tooltip !== null && <InfoTip text={feature.tooltip} />}
            </li>
          ))}
        </ul>
      )}
      <a
        href={actionHref}
        className={`rounded-md px-4 py-2 text-center text-sm font-medium transition-colors mt-8 ${featured ? "bg-white text-black hover:bg-white/90" : "border border-white/15 text-white/80 hover:border-white/25 hover:text-white"}`}
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

const TRIGGER_SURFACES = [
  { name: "GitHub", icon: <GitHubIcon className="h-6 w-6" />, body: "github" },
  { name: "Slack", icon: <SlackIcon className="h-6 w-6" />, body: "slack" },
  { name: "Discord", icon: <DiscordIcon className="h-6 w-6" />, body: "discord" },
] as const;

function Triggers() {
  const { t } = useTranslation();
  return (
    <section className="space-y-6">
      <h2 className="text-xl font-medium">{t("hub.triggers.title")}</h2>
      <p className="text-white/70 leading-relaxed max-w-2xl">{t("hub.triggers.description")}</p>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {TRIGGER_SURFACES.map((surface) => (
          <div
            key={surface.name}
            className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-5 py-4"
          >
            <span className="text-white/80">{surface.icon}</span>
            <span className="min-w-0">
              <span className="block font-medium">{surface.name}</span>
              <span className="block text-xs text-muted-foreground">
                {t(`hub.triggers.${surface.body}`)}
              </span>
            </span>
          </div>
        ))}
      </div>
      <DiscordDemo />
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

function DiscordDemo() {
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
              <span className="rounded-full bg-emerald-400/10 px-2 py-1 text-xs text-emerald-300">
                {t("hub.demo.filesChanged")}
              </span>
              <span className="rounded-full border border-white/10 px-2 py-1 text-xs text-white/40">
                {t("hub.demo.testsPassed")}
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
          <img src="/logo.svg" alt="" className="h-4 w-4" />
        ) : (
          <span className="text-xs font-medium text-white/60">M</span>
        )}
      </div>
      <div className="min-w-0 space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-white/90">{author}</span>
          {bot && (
            <span className="rounded bg-indigo-400/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-indigo-200">
              {t("hub.demo.bot")}
            </span>
          )}
          <span className="text-xs text-white/25">{time}</span>
        </div>
        <div className="space-y-2 text-sm text-white/70 leading-relaxed">{children}</div>
      </div>
    </div>
  );
}

const AGENT_LOGOS = [
  { name: "Claude Code", icon: <ClaudeCodeIcon className="h-6 w-6" /> },
  { name: "Codex", icon: <CodexIcon className="h-6 w-6" /> },
  { name: "OpenCode", icon: <OpenCodeIcon className="h-6 w-6" /> },
  { name: "Cursor", icon: <CursorIcon className="h-6 w-6" /> },
  { name: "Pi", icon: <PiIcon className="h-6 w-6" /> },
];

const MORE_AGENT_COUNT = AGENT_PAGES.length - AGENT_LOGOS.length;

function Agents() {
  const { t } = useTranslation();
  const localize = useLocalizePath();
  return (
    <section className="space-y-6">
      <h2 className="text-xl font-medium">{t("hub.agents.title")}</h2>
      <p className="text-white/70 leading-relaxed max-w-2xl">{t("hub.agents.description")}</p>
      <div className="flex flex-wrap items-center gap-3">
        {AGENT_LOGOS.map((agent) => (
          <div
            key={agent.name}
            className="flex items-center gap-2.5 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3"
          >
            <span className="text-white/80">{agent.icon}</span>
            <span className="text-sm font-medium">{agent.name}</span>
          </div>
        ))}
        <a
          href={localize("/agents")}
          className="rounded-xl border border-dashed border-white/10 bg-white/[0.01] px-4 py-3 text-sm font-medium text-white/50 hover:text-white/80 hover:border-white/20 transition-colors"
        >
          {t("common.more", { count: MORE_AGENT_COUNT })}
        </a>
      </div>
    </section>
  );
}

const DIAGRAM_SURFACES = [
  { name: "GitHub", icon: <GitHubIcon className="h-5 w-5" /> },
  { name: "Slack", icon: <SlackIcon className="h-5 w-5" /> },
  { name: "Discord", icon: <DiscordIcon className="h-5 w-5" /> },
];

const CLAUDE_MARK = { name: "Claude Code", icon: <ClaudeCodeIcon className="h-4 w-4" /> };
const CODEX_MARK = { name: "Codex", icon: <CodexIcon className="h-4 w-4" /> };
const OPENCODE_MARK = { name: "OpenCode", icon: <OpenCodeIcon className="h-4 w-4" /> };
const PI_MARK = { name: "Pi", icon: <PiIcon className="h-4 w-4" /> };

const DIAGRAM_DAEMONS = [
  { name: "MacBook Pro", agents: [CLAUDE_MARK, CODEX_MARK, OPENCODE_MARK] },
  { name: "Hetzner VM", agents: [CLAUDE_MARK, PI_MARK] },
];

const DIAGRAM_CLIENTS = ["desktop", "web", "mobile", "cli"] as const;

function Shape() {
  const { t } = useTranslation();
  return (
    <section className="space-y-6">
      <h2 className="text-xl font-medium">{t("hub.shape.title")}</h2>
      <p className="text-white/70 leading-relaxed max-w-2xl">{t("hub.shape.description")}</p>

      <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 md:p-8">
        <div className="flex flex-col items-center">
          <DiagramRow label={t("hub.shape.triggersRow")}>
            {DIAGRAM_SURFACES.map((surface) => (
              <DiagramCard key={surface.name} icon={surface.icon} name={surface.name} />
            ))}
            <DiagramCard name={t("hub.shape.yourTeam")} />
            <div className="flex items-center justify-center rounded-xl border border-dashed border-white/10 bg-white/[0.01] px-4 py-3 text-sm text-white/30">
              {t("hub.shape.futureIntegrations")}
            </div>
          </DiagramRow>

          <Connector label={t("hub.shape.webhooks")} />

          <div className="w-full max-w-xs rounded-xl border border-white/20 bg-white/[0.06] px-6 py-5 text-center">
            <p className="font-medium">{t("hub.shape.hub")}</p>
            <p className="text-xs text-muted-foreground mt-1">{t("hub.shape.hubHosting")}</p>
          </div>

          <Connector label={t("hub.shape.sameRpcs")} />

          <DiagramRow label={t("hub.shape.daemonsRow")}>
            {DIAGRAM_DAEMONS.map((daemon) => (
              <div
                key={daemon.name}
                className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3"
              >
                <span className="text-white/70">
                  <MachineIcon />
                </span>
                <span className="text-sm font-medium">{daemon.name}</span>
                <span className="flex items-center gap-2 border-l border-white/10 pl-3 text-white/40">
                  {daemon.agents.map((agent) => (
                    <span key={agent.name} title={agent.name}>
                      {agent.icon}
                    </span>
                  ))}
                </span>
              </div>
            ))}
          </DiagramRow>

          <Connector label={t("hub.shape.directOrRelay")} />

          <DiagramRow label={t("hub.shape.appsRow")}>
            {DIAGRAM_CLIENTS.map((client) => (
              <DiagramCard key={client} name={t(`hub.shape.${client}`)} />
            ))}
          </DiagramRow>
        </div>
      </div>
    </section>
  );
}

function DiagramRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="w-full space-y-2">
      <p className="text-center text-xs uppercase tracking-wide text-white/25">{label}</p>
      <div className="flex flex-wrap justify-center gap-3">{children}</div>
    </div>
  );
}

function DiagramCard({ name, icon }: { name: string; icon?: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
      {icon && <span className="text-white/70">{icon}</span>}
      <span className="text-sm font-medium">{name}</span>
    </div>
  );
}

function Connector({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center gap-2 py-4">
      <div className="h-5 w-px border-l border-dashed border-white/25" />
      <p className="text-center text-[11px] text-white/30">{label}</p>
      <div className="h-5 w-px border-l border-dashed border-white/25" />
    </div>
  );
}

function MachineIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2" y="2" width="20" height="8" rx="2" />
      <rect x="2" y="14" width="20" height="8" rx="2" />
      <circle cx="6" cy="6" r="1" />
      <circle cx="6" cy="18" r="1" />
    </svg>
  );
}

const SIMPLE_FAQ_ENTRIES = ["need", "hosted"] as const;
const LATER_FAQ_ENTRIES = ["move", "agents", "code"] as const;

function FaqSection() {
  const { t } = useTranslation();
  const localize = useLocalizePath();
  const links = React.useMemo(
    () => ({
      code: <code />,
      github: <a href="https://github.com/getpaseo/hub" className={LINK_CLASS} />,
      guide: <a href={localize("/docs/hub/self-hosting")} className={LINK_CLASS} />,
      hosted: <a href={HOSTED_HUB_URL} className={LINK_CLASS} />,
    }),
    [localize],
  );
  return (
    <section className="space-y-6">
      <h2 className="text-3xl font-medium">{t("hub.faq.title")}</h2>
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
        <FAQItem question={t("hub.faq.plannedQuestion")}>
          <p>{t("hub.faq.plannedIntro")}</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>{t("hub.faq.plannedProvisioning")}</li>
            <li>{t("hub.faq.plannedSharing")}</li>
            <li>{t("hub.faq.plannedIntegrations")}</li>
          </ul>
        </FAQItem>
        {LATER_FAQ_ENTRIES.map((entry) => (
          <FAQItem key={entry} question={t(`hub.faq.${entry}Question`)}>
            {t(`hub.faq.${entry}Answer`)}
          </FAQItem>
        ))}
        <FAQItem question={t("hub.faq.accessQuestion")}>
          <Trans i18nKey="hub.faq.accessAnswer" components={links} />
        </FAQItem>
      </div>
    </section>
  );
}
