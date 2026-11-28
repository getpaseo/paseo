import { Check, CircleDot, GitPullRequest, Tag } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
import { GitHubIcon } from "~/components/brand-icons";
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
  issue: 0.06,
  labelEvent: 0.55,
  botReply: 1.2,
  checks: 1.85,
} as const;

const GH_COMPONENTS = {
  mention: <span className="font-semibold text-[#58A6FF]">@paseo-bot</span>,
  host: (
    <span className="rounded-[4px] border border-[#30363D] bg-[#161B22] px-1.5 py-[1px] font-mono text-[11px] text-[#E6EDF3]" />
  ),
  pr: <span className="font-medium text-[#58A6FF] underline decoration-[#58A6FF]/40" />,
  code: (
    <code className="rounded-[4px] bg-[#21262D] px-1.5 py-[1px] font-mono text-[11.5px] text-[#E6EDF3]" />
  ),
};

const CHECK_NAMES = ["typecheck", "vitest", "lint", "build"] as const;

export function GitHubSourceMockup({ active, reduceMotion }: SourceMockupProps) {
  const { t } = useTranslation();

  return (
    <MockupStageWindow
      ariaLabel={t("hub.demo.github.alt")}
      active={active}
      reduceMotion={reduceMotion}
      className="border-[#30363D] bg-[#0D1117]"
    >
      <GitHubChrome />
      <GitHubIssueHeader />
      <div className="grid min-h-0 flex-1 grid-cols-1 sm:grid-cols-[minmax(0,1fr)_156px]">
        <GitHubTimeline />
        <GitHubSidebar />
      </div>
    </MockupStageWindow>
  );
}

function GitHubTimeline() {
  const { t } = useTranslation();
  return (
    <div className="relative space-y-3 px-4 py-3.5">
      <span
        aria-hidden="true"
        className="pointer-events-none absolute top-11 bottom-6 left-[27px] w-[2px] bg-[#21262D]"
      />

      <MockupStep delay={STEP_DELAYS.issue} className="relative">
        <GitHubComment
          author="mo"
          badge={t("hub.demo.github.authorBadge")}
          timestamp={t("hub.demo.github.openedAgo")}
        >
          <p>
            <Trans i18nKey="hub.demo.github.issueBody" components={GH_COMPONENTS} />
          </p>
        </GitHubComment>
      </MockupStep>

      <MockupStep
        delay={STEP_DELAYS.labelEvent}
        className="relative flex items-center gap-2.5 pl-1"
      >
        <span className="relative z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-[#30363D] bg-[#161B22] text-[#8B949E]">
          <Tag className="h-3 w-3" aria-hidden="true" />
        </span>
        <div className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-[#8B949E]">
          <span className="font-semibold text-[#E6EDF3]">mo</span>
          <span>{t("hub.demo.github.addedLabel")}</span>
          <span className="rounded-full border border-[#20744A]/60 bg-[#20744A]/20 px-2 py-[1px] font-mono text-[10.5px] font-medium text-[#6CB17B]">
            paseo
          </span>
          <span>·</span>
          <span>{t("hub.demo.github.startedOn")}</span>
        </div>
      </MockupStep>

      <MockupStep delay={STEP_DELAYS.botReply} className="relative">
        <GitHubComment
          author="paseo-bot"
          badge={t("hub.demo.github.botBadge")}
          timestamp={t("hub.demo.github.repliedAgo")}
          bot
        >
          <p>
            <Trans i18nKey="hub.demo.github.botReply" components={GH_COMPONENTS} />
          </p>
          <GitHubPrSummaryCard />
        </GitHubComment>
      </MockupStep>
    </div>
  );
}

function GitHubPrSummaryCard() {
  const { t } = useTranslation();
  return (
    <MockupStep
      delay={STEP_DELAYS.checks}
      className="mt-2.5 overflow-hidden rounded-md border border-[#30363D] bg-[#0D1117]"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#21262D] bg-[#161B22] px-3 py-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <GitPullRequest className="h-3.5 w-3.5 shrink-0 text-[#3FB950]" aria-hidden="true" />
          <span className="text-[12px] font-semibold text-[#E6EDF3]">
            fix(terminal): drain PTY write queue under burst
          </span>
          <span className="font-mono text-[11px] text-[#8B949E]">#2819</span>
        </div>
        <span className="shrink-0 font-mono text-[11px]">
          <span className="text-[#3FB950]">+84</span> <span className="text-[#F85149]">-19</span>
        </span>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="inline-flex items-center gap-1 text-[11.5px] font-medium text-[#3FB950]">
            <Check className="h-3.5 w-3.5" aria-hidden="true" />
            {t("hub.demo.github.checksPassed")}
          </span>
          <span className="hidden items-center gap-1 sm:inline-flex">
            {CHECK_NAMES.map((name) => (
              <span
                key={name}
                className="rounded border border-[#30363D] bg-[#161B22] px-1.5 py-[1px] font-mono text-[10px] text-[#8B949E]"
              >
                {name}
              </span>
            ))}
          </span>
        </div>
        <OpenInPaseoChip variant="brand" />
      </div>
    </MockupStep>
  );
}

function GitHubChrome() {
  return (
    <div className="flex h-9 shrink-0 items-center justify-between border-b border-[#21262D] bg-[#010409] px-3.5">
      <div className="flex items-center gap-3">
        <WindowTrafficLights />
        <div className="flex items-center gap-1.5 text-[12px] text-[#8B949E]">
          <GitHubIcon className="h-3.5 w-3.5 text-[#E6EDF3]" />
          <span>getpaseo</span>
          <span className="text-[#484F58]">/</span>
          <span className="font-semibold text-[#E6EDF3]">paseo</span>
        </div>
      </div>

      <div
        className="hidden items-center gap-4 text-[11.5px] text-[#8B949E] sm:flex"
        aria-hidden="true"
      >
        <span className="relative py-2 font-medium text-[#E6EDF3]">
          Issues
          <span className="absolute right-0 -bottom-[3px] left-0 h-[2px] rounded-full bg-[#F78166]" />
        </span>
        <span>Pull requests</span>
        <span>Actions</span>
      </div>
    </div>
  );
}

function GitHubIssueHeader() {
  const { t } = useTranslation();
  return (
    <div className="shrink-0 border-b border-[#21262D] px-4 py-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h4 className="text-[15px] font-semibold text-[#E6EDF3]">
          {t("hub.demo.github.issueTitle")}
        </h4>
        <span className="font-mono text-[14px] text-[#8B949E]">#2811</span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11.5px] text-[#8B949E]">
        <span className="inline-flex items-center gap-1 rounded-full bg-[#238636] px-2.5 py-0.5 text-[11px] font-semibold text-white">
          <CircleDot className="h-3 w-3" aria-hidden="true" />
          Open
        </span>
        <span>
          <strong className="font-semibold text-[#E6EDF3]">mo</strong>{" "}
          {t("hub.demo.github.issueMeta")}
        </span>
      </div>
    </div>
  );
}

function GitHubComment({
  author,
  badge,
  timestamp,
  bot,
  children,
}: {
  author: string;
  badge: string;
  timestamp: string;
  bot?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-2.5">
      {bot ? (
        <PaseoBotAvatar size="sm" rounded="rounded-full" className="relative z-10 mt-0.5 h-7 w-7" />
      ) : (
        <MoAvatar size="sm" rounded="rounded-full" className="relative z-10 mt-0.5 h-7 w-7" />
      )}
      <div className="min-w-0 flex-1 overflow-hidden rounded-md border border-[#30363D] bg-[#0D1117]">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#21262D] bg-[#161B22] px-3 py-1.5 text-[11.5px]">
          <div className="flex items-center gap-1.5">
            <span className="font-semibold text-[#E6EDF3]">{author}</span>
            <span className="rounded-full border border-[#30363D] px-1.5 py-[0.5px] text-[10px] font-medium text-[#8B949E]">
              {badge}
            </span>
          </div>
          <span className="text-[11px] text-[#8B949E]">{timestamp}</span>
        </div>
        <div className="px-3 py-2.5 text-[12.5px] leading-[1.5] text-[#C9D1D9]">{children}</div>
      </div>
    </div>
  );
}

function GitHubSidebar() {
  const { t } = useTranslation();
  return (
    <aside
      aria-hidden="true"
      className="hidden flex-col gap-3.5 border-l border-[#21262D] px-3.5 py-3.5 text-[11.5px] sm:flex"
    >
      <div className="space-y-1.5 border-b border-[#21262D] pb-3">
        <p className="font-medium text-[#8B949E]">{t("hub.demo.github.assignees")}</p>
        <div className="flex items-center gap-1.5 text-[#E6EDF3]">
          <PaseoBotAvatar size="xs" rounded="rounded-full" />
          <span className="font-medium">paseo-bot</span>
        </div>
      </div>

      <div className="space-y-1.5 border-b border-[#21262D] pb-3">
        <p className="font-medium text-[#8B949E]">{t("hub.demo.github.labels")}</p>
        <div className="flex flex-wrap gap-1">
          <span className="rounded-full border border-[#F85149]/40 bg-[#F85149]/15 px-2 py-[1px] text-[10.5px] font-medium text-[#FF7B72]">
            bug
          </span>
          <span className="rounded-full border border-[#D29922]/40 bg-[#D29922]/15 px-2 py-[1px] text-[10.5px] font-medium text-[#E3B341]">
            p0
          </span>
          <span className="rounded-full border border-[#20744A]/60 bg-[#20744A]/20 px-2 py-[1px] text-[10.5px] font-medium text-[#6CB17B]">
            paseo
          </span>
        </div>
      </div>

      <div className="space-y-1.5 border-b border-[#21262D] pb-3">
        <p className="font-medium text-[#8B949E]">{t("hub.demo.github.development")}</p>
        <div className="flex items-center gap-1.5 text-[#58A6FF]">
          <GitPullRequest className="h-3.5 w-3.5 shrink-0 text-[#3FB950]" />
          <span className="font-mono text-[11.5px]">#2819</span>
        </div>
      </div>

      <div className="space-y-1">
        <p className="font-medium text-[#8B949E]">{t("hub.demo.github.daemon")}</p>
        <span className="inline-block rounded border border-[#30363D] bg-[#161B22] px-1.5 py-0.5 font-mono text-[11px] text-[#E6EDF3]">
          macbook-pro
        </span>
      </div>
    </aside>
  );
}
