import { Check, ChevronRight, GitPullRequest, SignalHigh } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
import { LinearIcon } from "~/components/brand-icons";
import {
  MoAvatar,
  MockupStageWindow,
  MockupStep,
  OpenInPaseoChip,
  PaseoBotAvatar,
  type SourceMockupProps,
  WindowTrafficLights,
} from "./shared";

const STEP_DELAYS = {
  assigned: 0.08,
  running: 0.65,
  comment: 1.35,
} as const;

const LINEAR_COMPONENTS = {
  host: (
    <span className="rounded bg-[#22252E] px-1.5 py-[1px] font-mono text-[11px] text-[#E3E6F0]" />
  ),
  code: (
    <code className="rounded bg-[#22252E] px-1.5 py-[1px] font-mono text-[11px] text-[#C5CCDF]" />
  ),
};

export function LinearSourceMockup({ active, reduceMotion }: SourceMockupProps) {
  const { t } = useTranslation();

  return (
    <MockupStageWindow
      ariaLabel={t("hub.demo.linear.alt")}
      active={active}
      reduceMotion={reduceMotion}
      className="border-[#262932] bg-[#111318]"
    >
      <LinearChrome />

      <div className="grid min-h-0 flex-1 grid-cols-1 sm:grid-cols-[minmax(0,1fr)_172px]">
        <LinearIssuePane />
        <LinearPropertiesSidebar />
      </div>
    </MockupStageWindow>
  );
}

function LinearIssuePane() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-0 flex-col px-5 py-4">
      <div className="space-y-1.5 border-b border-[#22252E] pb-3.5">
        <p className="font-mono text-[11.5px] text-[#8A8F9E]">PAS-418</p>
        <h4 className="text-[16px] font-semibold tracking-[-0.01em] text-[#F1F3F8]">
          {t("hub.demo.linear.issueTitle")}
        </h4>
        <p className="text-[12.5px] leading-relaxed text-[#9DA3B4]">
          {t("hub.demo.linear.issueDescription")}
        </p>
      </div>

      <LinearActivityFeed />
    </div>
  );
}

function LinearActivityFeed() {
  const { t } = useTranslation();
  return (
    <div className="mt-3.5 flex-1 space-y-3">
      <p className="text-[11px] font-medium uppercase tracking-wider text-[#6D7385]">
        {t("hub.demo.linear.activity")}
      </p>

      <MockupStep
        delay={STEP_DELAYS.assigned}
        className="flex items-center gap-2 text-[12px] text-[#9DA3B4]"
      >
        <MoAvatar size="xs" rounded="rounded-full" />
        <span className="min-w-0">
          <strong className="font-medium text-[#ECEEF4]">mo</strong>{" "}
          {t("hub.demo.linear.assignedEvent")}{" "}
          <strong className="font-medium text-[#ECEEF4]">paseo-bot</strong>
        </span>
        <span className="ml-auto shrink-0 text-[11px] text-[#6D7385]">11m</span>
      </MockupStep>

      <LinearRunStatusRow />
      <LinearBotCommentCard />
    </div>
  );
}

function LinearRunStatusRow() {
  const { t } = useTranslation();
  return (
    <MockupStep
      delay={STEP_DELAYS.running}
      className="flex items-center gap-2.5 rounded-lg border border-[#242834] bg-[#171A21] px-3 py-2 text-[12px]"
    >
      <PaseoBotAvatar size="sm" rounded="rounded-full" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-medium text-[#ECEEF4]">paseo-bot</span>
          <span className="text-[#6D7385]">·</span>
          <span className="text-[#9DA3B4]">
            <Trans i18nKey="hub.demo.linear.runningOn" components={LINEAR_COMPONENTS} />
          </span>
        </div>
        <p className="mt-0.5 font-mono text-[11px] wrap-anywhere text-[#7D8599]">
          {t("hub.demo.linear.traceLine")}
        </p>
      </div>
      <Check className="h-3.5 w-3.5 shrink-0 text-[#6CB17B]" aria-hidden="true" />
    </MockupStep>
  );
}

function LinearBotCommentCard() {
  const { t } = useTranslation();
  return (
    <MockupStep
      delay={STEP_DELAYS.comment}
      className="rounded-lg border border-[#262A36] bg-[#161820] p-3.5"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <PaseoBotAvatar size="sm" rounded="rounded-full" />
          <span className="text-[12.5px] font-semibold text-[#F1F3F8]">paseo-bot</span>
          <span className="rounded bg-[#252936] px-1.5 py-[1px] text-[10px] font-medium uppercase tracking-wide text-[#9DA3B4]">
            {t("hub.demo.shared.appBadge")}
          </span>
        </div>
        <span className="text-[11px] text-[#6D7385]">6m</span>
      </div>

      <p className="mt-2 text-[12.5px] leading-[1.5] text-[#C5CCDF]">
        <Trans i18nKey="hub.demo.linear.botSummary" components={LINEAR_COMPONENTS} />
      </p>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[#242834] pt-2.5">
        <span className="inline-flex items-center gap-1.5 rounded-md border border-[#2A2F3D] bg-[#1C1F2A] px-2 py-1 font-mono text-[11px] text-[#C5CCDF]">
          <GitPullRequest className="h-3 w-3 text-[#6CB17B]" aria-hidden="true" />
          <span>#2822</span>
          <span className="text-[#6CB17B]">· {t("hub.demo.shared.testsPassed")}</span>
        </span>
        <OpenInPaseoChip variant="brand" />
      </div>
    </MockupStep>
  );
}

function LinearChrome() {
  return (
    <div className="flex min-h-9 shrink-0 items-center justify-between border-b border-[#22252E] bg-[#15171E] px-3.5 py-1">
      <div className="flex items-center gap-3">
        <WindowTrafficLights />
        <div className="flex flex-wrap items-center gap-1 text-[11.5px] text-[#8A8F9E]">
          <LinearIcon className="h-3.5 w-3.5 text-[#5E6AD2]" />
          <span>Paseo</span>
          <ChevronRight className="h-3 w-3 text-[#555B6E]" aria-hidden="true" />
          <span>Core</span>
          <ChevronRight className="h-3 w-3 text-[#555B6E]" aria-hidden="true" />
          <span className="font-mono text-[#E3E6F0]">PAS-418</span>
        </div>
      </div>

      <span className="hidden rounded-full border border-[#5E6AD2]/35 bg-[#5E6AD2]/15 px-2 py-0.5 text-[10.5px] font-medium text-[#A4ACEE] sm:inline-block">
        Cycle 14
      </span>
    </div>
  );
}

function LinearPropertiesSidebar() {
  const { t } = useTranslation();
  return (
    <aside
      aria-hidden="true"
      className="hidden flex-col gap-3.5 border-l border-[#22252E] bg-[#13151B] px-3.5 py-4 text-[11.5px] sm:flex"
    >
      <p className="text-[11px] font-medium text-[#6D7385]">{t("hub.demo.linear.properties")}</p>

      <LinearPropRow label={t("hub.demo.linear.status")}>
        <span className="inline-flex items-center gap-1.5 text-[#ECEEF4]">
          <span className="h-2.5 w-2.5 rounded-full border-2 border-[#6CB17B] bg-[#6CB17B]/35" />
          <span>In Review</span>
        </span>
      </LinearPropRow>

      <LinearPropRow label={t("hub.demo.linear.priority")}>
        <span className="inline-flex items-center gap-1.5 text-[#ECEEF4]">
          <SignalHigh className="h-3.5 w-3.5 text-[#F2994A]" />
          <span>High</span>
        </span>
      </LinearPropRow>

      <LinearPropRow label={t("hub.demo.linear.assignee")}>
        <span className="inline-flex items-center gap-1.5 text-[#ECEEF4]">
          <PaseoBotAvatar size="xs" rounded="rounded-full" />
          <span>paseo-bot</span>
        </span>
      </LinearPropRow>

      <LinearPropRow label={t("hub.demo.linear.creator")}>
        <span className="inline-flex items-center gap-1.5 text-[#ECEEF4]">
          <MoAvatar size="xs" rounded="rounded-full" />
          <span>mo</span>
        </span>
      </LinearPropRow>

      <LinearPropRow label={t("hub.demo.linear.labels")}>
        <div className="flex flex-wrap gap-1">
          <span className="inline-flex items-center gap-1 rounded-full border border-[#2A2F3D] bg-[#1A1D26] px-2 py-[1px] text-[10.5px] text-[#C5CCDF]">
            <span className="h-1.5 w-1.5 rounded-full bg-[#5E6AD2]" />
            mobile
          </span>
          <span className="inline-flex items-center gap-1 rounded-full border border-[#2A2F3D] bg-[#1A1D26] px-2 py-[1px] text-[10.5px] text-[#C5CCDF]">
            <span className="h-1.5 w-1.5 rounded-full bg-[#6CB17B]" />
            relay
          </span>
        </div>
      </LinearPropRow>

      <LinearPropRow label={t("hub.demo.linear.daemon")}>
        <span className="rounded border border-[#2A2F3D] bg-[#1A1D26] px-1.5 py-0.5 font-mono text-[10.5px] text-[#C5CCDF]">
          devbox
        </span>
      </LinearPropRow>
    </aside>
  );
}

function LinearPropRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-[10.5px] text-[#6D7385]">{label}</p>
      <div>{children}</div>
    </div>
  );
}
