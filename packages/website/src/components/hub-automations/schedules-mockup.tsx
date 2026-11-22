import { Check, Clock, GitPullRequest, Hash, TrendingDown } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
import {
  MockupStageWindow,
  MockupStep,
  OpenInPaseoChip,
  PaseoBotAvatar,
  type SourceMockupProps,
  WindowTrafficLights,
} from "./shared";
import { SlackColorMark } from "./slack-mockup";

const STEP_DELAYS = {
  triggered: 0.06,
  prOpened: 0.7,
  slackDigest: 1.4,
} as const;

const SCHEDULE_COMPONENTS = {
  code: (
    <code className="rounded bg-white/[0.07] px-1.5 py-[1px] font-mono text-[11px] text-white/90" />
  ),
  pr: <span className="font-medium text-[#1D9BD1] underline decoration-[#1D9BD1]/40" />,
  strong: <strong className="font-semibold text-white" />,
};

export function SchedulesSourceMockup({ active, reduceMotion }: SourceMockupProps) {
  const { t } = useTranslation();

  return (
    <MockupStageWindow
      ariaLabel={t("hub.demo.schedules.alt")}
      active={active}
      reduceMotion={reduceMotion}
      className="border-white/[0.1] bg-[#121716]"
    >
      <ScheduleChrome />
      <ScheduleHeaderBar />
      <div className="flex flex-1 flex-col justify-between gap-3 px-4 py-3.5">
        <ScheduleStepsList />
        <ScheduleImpactMetrics />
        <ScheduleSlackDigestCard />
      </div>
    </MockupStageWindow>
  );
}

function ScheduleChrome() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-9 shrink-0 items-center justify-between gap-2 border-b border-white/[0.07] bg-[#0D1211] px-3.5 py-1">
      <div className="flex min-w-0 items-center gap-3">
        <WindowTrafficLights />
        <div className="flex min-w-0 items-center gap-1.5 font-mono text-[11.5px] text-white/65">
          <Clock className="h-3.5 w-3.5 shrink-0 text-accent-text" aria-hidden="true" />
          <span className="wrap-anywhere">.paseo/triggers/daily-ci-optimizer.yml</span>
        </div>
      </div>
      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-brand-green/50 bg-brand-green/20 px-2 py-0.5 text-[10.5px] font-medium text-accent-text">
        <span className="h-1.5 w-1.5 rounded-full bg-[#35C264]" />
        {t("hub.demo.schedules.active")}
      </span>
    </div>
  );
}

function ScheduleHeaderBar() {
  const { t } = useTranslation();
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-white/[0.07] bg-white/[0.02] px-4 py-2.5">
      <div>
        <h4 className="text-[14px] font-semibold text-white/95">
          {t("hub.demo.schedules.jobTitle")}
        </h4>
        <p className="text-[11.5px] text-white/55">{t("hub.demo.schedules.cadence")}</p>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 font-mono text-[11px]">
        <span className="rounded border border-white/10 bg-[#0D1211] px-2 py-0.5 text-accent-text">
          0 7 * * 1-5
        </span>
        <span className="rounded border border-white/10 bg-[#0D1211] px-2 py-0.5 text-white/70">
          devbox · Claude Code
        </span>
      </div>
    </div>
  );
}

function ScheduleStepsList() {
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      <MockupStep delay={STEP_DELAYS.triggered} className="flex items-start gap-2.5">
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-brand-green/45 bg-brand-green/15 text-accent-text">
          <Check className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2 text-[12px]">
            <span className="font-medium text-white/90">{t("hub.demo.schedules.step1Title")}</span>
            <span className="font-mono text-[11px] text-white/40">7:00 AM</span>
          </div>
          <p className="mt-0.5 text-[12px] leading-relaxed text-white/65">
            <Trans i18nKey="hub.demo.schedules.step1Detail" components={SCHEDULE_COMPONENTS} />
          </p>
        </div>
      </MockupStep>

      <MockupStep delay={STEP_DELAYS.prOpened} className="flex items-start gap-2.5">
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-brand-green/45 bg-brand-green/15 text-accent-text">
          <GitPullRequest className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2 text-[12px]">
            <span className="font-medium text-white/90">{t("hub.demo.schedules.step2Title")}</span>
            <span className="font-mono text-[11px] text-white/40">7:04 AM</span>
          </div>
          <SchedulePrPill />
        </div>
      </MockupStep>
    </div>
  );
}

function SchedulePrPill() {
  const { t } = useTranslation();
  return (
    <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/[0.08] bg-[#171E1D] px-3 py-2">
      <div className="flex min-w-0 items-center gap-1.5 text-[12px]">
        <span className="font-medium text-white/90">
          perf(ci): cache cargo target & stabilize e2e wait
        </span>
        <span className="font-mono text-[11px] text-white/45">#2831</span>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5 font-mono text-[10.5px]">
        <span className="inline-flex items-center gap-1 rounded bg-[#2BAC76]/15 px-1.5 py-0.5 text-[#6CB17B]">
          <TrendingDown className="h-3 w-3" aria-hidden="true" />
          CI -38%
        </span>
        <span className="inline-flex items-center gap-1 rounded border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-white/70">
          <Check className="h-3 w-3 text-[#6CB17B]" aria-hidden="true" />
          {t("hub.demo.shared.testsPassed")}
        </span>
      </div>
    </div>
  );
}

function ScheduleImpactMetrics() {
  const { t } = useTranslation();
  return (
    <MockupStep
      delay={1.05}
      className="grid grid-cols-3 divide-x divide-white/[0.07] overflow-hidden rounded-lg border border-white/[0.07] bg-white/[0.02]"
    >
      <div className="px-3 py-2">
        <p className="text-[10.5px] text-white/45">{t("hub.demo.schedules.metricRuntime")}</p>
        <p className="mt-0.5 font-mono text-[12px] font-medium text-accent-text">7m 12s → 4m 28s</p>
      </div>
      <div className="px-3 py-2">
        <p className="text-[10.5px] text-white/45">{t("hub.demo.schedules.metricFlake")}</p>
        <p className="mt-0.5 font-mono text-[12px] font-medium text-accent-text">18% → 0%</p>
      </div>
      <div className="px-3 py-2">
        <p className="text-[10.5px] text-white/45">{t("hub.demo.schedules.metricCache")}</p>
        <p className="mt-0.5 font-mono text-[12px] font-medium text-white/85">94% hit</p>
      </div>
    </MockupStep>
  );
}

function ScheduleSlackDigestCard() {
  const { t } = useTranslation();
  return (
    <MockupStep
      delay={STEP_DELAYS.slackDigest}
      className="overflow-hidden rounded-lg border border-[#35373B] bg-[#1A1D21]"
    >
      <div className="flex items-center justify-between border-b border-[#2C2D30] bg-[#14161A] px-3 py-1.5 text-[11px] text-[#ABABAD]">
        <span className="inline-flex items-center gap-1.5 font-medium text-[#E5E7EB]">
          <SlackColorMark className="h-3 w-3" />
          <Hash className="h-3 w-3 text-[#ABABAD]" aria-hidden="true" />
          engineering
        </span>
        <span>{t("hub.demo.schedules.slackPosted")}</span>
      </div>

      <div className="flex items-start gap-2.5 px-3.5 py-3">
        <PaseoBotAvatar size="sm" className="mt-0.5 h-8 w-8" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex items-center gap-1.5">
            <span className="text-[13px] font-bold text-[#F8F8F8]">paseo-bot</span>
            <span className="rounded-[3px] bg-[#2C2D30] px-1.5 py-[1px] text-[9.5px] font-semibold uppercase tracking-wide text-[#ABABAD]">
              {t("hub.demo.shared.appBadge")}
            </span>
            <span className="text-[11px] text-[#ABABAD]">7:05 AM</span>
          </div>
          <p className="text-[12.5px] leading-[1.45] text-[#D1D2D3]">
            <Trans i18nKey="hub.demo.schedules.slackSummary" components={SCHEDULE_COMPONENTS} />
          </p>
          <div className="flex flex-wrap items-center gap-2 pt-0.5">
            <OpenInPaseoChip variant="slack" />
            <span className="text-[11px] text-[#ABABAD]">{t("hub.demo.schedules.notifiedMo")}</span>
          </div>
        </div>
      </div>
    </MockupStep>
  );
}
