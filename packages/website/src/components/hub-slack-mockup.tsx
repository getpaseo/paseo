import { motion, useReducedMotion, type Variants } from "framer-motion";
import {
  AtSign,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Code,
  GitPullRequest,
  Hash,
  Plus,
  Search,
  SendHorizontal,
  SquarePen,
} from "lucide-react";
import type { ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import { PaseoHubMark, PaseoMark } from "~/components/paseo-brand";

const VIEWPORT_60 = { once: true, margin: "-60px" };

const DEMO_ISSUES = [
  { id: "#2811", title: "Terminal output drops under load" },
  { id: "#2804", title: "Relay reconnect loop on Android after sleep" },
  { id: "#2799", title: "Worktree cleanup leaves stale branches" },
] as const;

const SIDEBAR_CHANNELS = ["general", "engineering", "incidents", "releases"] as const;

const STEP_DELAYS = {
  firstPrompt: 0.08,
  firstReply: 1.25,
  followUp: 2.25,
  finalReply: 3.55,
} as const;

const MESSAGE_VARIANTS: Variants = {
  hidden: { opacity: 0, y: 6 },
  shown: (delay: number) => ({
    opacity: 1,
    y: 0,
    transition: { delay, duration: 0.35, ease: "easeOut" },
  }),
};

const TYPING_VARIANTS: Variants = {
  hidden: { opacity: 0 },
  shown: {
    opacity: [0, 1, 1, 0, 0, 1, 1, 0],
    transition: {
      duration: 3.9,
      times: [0, 0.1, 0.28, 0.32, 0.62, 0.68, 0.88, 0.92],
      ease: "linear",
    },
  },
};

const DEMO_COMPONENTS = {
  mention: <SlackMention />,
  host: (
    <span className="rounded-[3px] border border-white/10 bg-[#222529] px-1.5 py-[1px] font-mono text-[12px] text-[#E8912D]" />
  ),
  pr: <span className="font-medium text-[#1D9BD1] underline decoration-[#1D9BD1]/40" />,
};

/**
 * Animated Slack dark-mode conversation mockup showing a developer mentioning @paseo-bot in
 * #engineering, getting P0 issues back, steering the same agent in-thread to open a PR, and
 * opening the live session in Paseo. All elements stay in flow so height never shifts.
 */
export function HubSlackMockup() {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotion();

  return (
    <figure className="space-y-3">
      <motion.div
        role="img"
        aria-label={t("hub.demo.alt")}
        initial={reduceMotion ? "shown" : "hidden"}
        whileInView="shown"
        viewport={VIEWPORT_60}
        className="overflow-hidden rounded-xl border border-[#35373B] bg-[#1A1D21] shadow-[0_24px_64px_-24px_rgba(0,0,0,0.75)]"
      >
        <SlackWindowChrome />
        <div className="grid grid-cols-1 md:grid-cols-[204px_minmax(0,1fr)]">
          <SlackSidebar />
          <div className="flex min-w-0 flex-col bg-[#1A1D21]">
            <SlackChannelHeader />
            <SlackMessageFeed />
            <SlackComposer />
            <SlackTypingStatus reduced={reduceMotion === true} />
          </div>
        </div>
      </motion.div>
      <figcaption className="text-sm text-muted-foreground">{t("hub.demo.caption")}</figcaption>
    </figure>
  );
}

function SlackWindowChrome() {
  const { t } = useTranslation();
  return (
    <div className="flex h-9 items-center justify-between border-b border-[#2C2D30] bg-[#121016] px-3.5">
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5" aria-hidden="true">
          <span className="h-2.5 w-2.5 rounded-full bg-[#FF5F57]/85" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#FEBC2E]/85" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#28C840]/85" />
        </div>
        <div className="hidden items-center gap-1 text-[#ABABAD]/60 sm:flex" aria-hidden="true">
          <ChevronLeft className="h-3.5 w-3.5" />
          <ChevronRight className="h-3.5 w-3.5" />
        </div>
      </div>

      <div className="flex h-6 w-44 items-center gap-1.5 rounded-[5px] bg-white/[0.08] px-2.5 text-[11px] text-[#ABABAD] sm:w-64">
        <Search className="h-3 w-3 shrink-0 text-[#ABABAD]/75" aria-hidden="true" />
        <span className="truncate">{t("hub.demo.searchPlaceholder")}</span>
      </div>

      <SlackColorMark className="h-3.5 w-3.5 shrink-0" />
    </div>
  );
}

function SlackSidebar() {
  const { t } = useTranslation();
  return (
    <aside
      aria-hidden="true"
      className="hidden flex-col border-r border-[#2C2D30] bg-[#19171D] md:flex"
    >
      <div className="flex items-center justify-between border-b border-white/[0.07] px-3.5 py-2.5">
        <div className="flex items-center gap-1 text-[14px] font-bold text-[#F8F8F8]">
          <span>Paseo</span>
          <ChevronDown className="h-3.5 w-3.5 text-[#ABABAD]" />
        </div>
        <SquarePen className="h-3.5 w-3.5 text-[#ABABAD]" />
      </div>

      <div className="space-y-4 px-2 py-3 text-[13px]">
        <div className="space-y-0.5">
          <p className="px-2 pb-1 text-[11px] font-medium text-[#ABABAD]/75">
            {t("hub.demo.channels")}
          </p>
          {SIDEBAR_CHANNELS.map((channel) => (
            <div
              key={channel}
              className={`flex items-center gap-1.5 rounded-[6px] px-2 py-1 ${
                channel === "engineering" ? "bg-[#1164A3] font-medium text-white" : "text-[#ABABAD]"
              }`}
            >
              <Hash className="h-3.5 w-3.5 shrink-0 opacity-80" />
              <span className="truncate">{channel}</span>
            </div>
          ))}
        </div>

        <div className="space-y-0.5">
          <p className="px-2 pb-1 text-[11px] font-medium text-[#ABABAD]/75">
            {t("hub.demo.apps")}
          </p>
          <div className="flex items-center gap-2 rounded-[6px] px-2 py-1 text-[#D1D2D3]">
            <span className="relative flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] bg-[#101615] ring-1 ring-white/15">
              <PaseoHubMark className="h-2.5 w-2.5 text-white" />
              <span className="absolute -right-0.5 -bottom-0.5 h-1.5 w-1.5 rounded-full bg-[#2BAC76] ring-1 ring-[#19171D]" />
            </span>
            <span className="truncate">paseo-bot</span>
          </div>
        </div>
      </div>
    </aside>
  );
}

function SlackChannelHeader() {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-between gap-3 border-b border-[#2C2D30] px-4 py-2.5 md:px-5">
      <div className="flex min-w-0 items-center gap-2">
        <div className="flex items-center gap-1 text-[15px] font-bold text-[#F8F8F8]">
          <Hash className="h-4 w-4 shrink-0 text-[#D1D2D3]" aria-hidden="true" />
          <span>engineering</span>
        </div>
        <span className="hidden truncate text-xs text-[#ABABAD] sm:inline">
          {t("hub.demo.channelTopic")}
        </span>
      </div>

      <div
        aria-hidden="true"
        className="flex shrink-0 items-center gap-1.5 rounded-[5px] border border-[#35373B] px-2 py-0.5 text-[11px] text-[#ABABAD]"
      >
        <div className="flex -space-x-1">
          <img
            src="/9viSwGkz_400x400.jpg"
            alt=""
            width={16}
            height={16}
            className="h-4 w-4 rounded-[3px] object-cover ring-1 ring-[#1A1D21]"
          />
          <span className="flex h-4 w-4 items-center justify-center rounded-[3px] bg-[#101615] ring-1 ring-[#1A1D21]">
            <PaseoHubMark className="h-2.5 w-2.5 text-white" />
          </span>
        </div>
        <span className="tabular-nums">4</span>
      </div>
    </div>
  );
}

function SlackMessageFeed() {
  const { t } = useTranslation();
  return (
    <div className="space-y-4 px-4 py-4 md:px-5">
      <motion.div variants={MESSAGE_VARIANTS} custom={STEP_DELAYS.firstPrompt}>
        <SlackMessage author="moboudra" time="9:41 AM">
          <p>
            <Trans i18nKey="hub.demo.showIssues" components={DEMO_COMPONENTS} />
          </p>
        </SlackMessage>
      </motion.div>

      <div className="ml-3 sm:ml-4">
        <motion.div
          variants={MESSAGE_VARIANTS}
          custom={STEP_DELAYS.firstReply}
          className="space-y-3 border-l-2 border-[#2C2D30] pb-4 pl-3.5 sm:pl-4"
        >
          <div className="flex items-center gap-2 text-[11px]">
            <span className="font-medium text-[#1D9BD1]">{t("hub.demo.threadReplies")}</span>
            <span className="h-px flex-1 bg-[#2C2D30]" aria-hidden="true" />
          </div>

          <SlackMessage author="paseo-bot" time="9:41 AM" bot>
            <p>{t("hub.demo.issuesOpen")}</p>
            <ul className="mt-1.5 space-y-1 border-l-[3px] border-[#36C5F0] pl-3">
              {DEMO_ISSUES.map((issue) => (
                <li key={issue.id} className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-mono text-[12.5px] font-medium text-[#1D9BD1]">
                    {issue.id}
                  </span>
                  <span className="text-[#D1D2D3]">{issue.title}</span>
                </li>
              ))}
            </ul>
          </SlackMessage>
        </motion.div>

        <motion.div
          variants={MESSAGE_VARIANTS}
          custom={STEP_DELAYS.followUp}
          className="border-l-2 border-[#2C2D30] pb-4 pl-3.5 sm:pl-4"
        >
          <SlackMessage author="moboudra" time="9:43 AM">
            <p>
              <Trans i18nKey="hub.demo.createPr" components={DEMO_COMPONENTS} />
            </p>
          </SlackMessage>
        </motion.div>

        <motion.div
          variants={MESSAGE_VARIANTS}
          custom={STEP_DELAYS.finalReply}
          className="border-l-2 border-[#2C2D30] pl-3.5 sm:pl-4"
        >
          <SlackMessage author="paseo-bot" time="9:48 AM" bot>
            <p>
              <Trans i18nKey="hub.demo.ranOn" components={DEMO_COMPONENTS} />
            </p>
            <SlackPrAttachment />
          </SlackMessage>
        </motion.div>
      </div>
    </div>
  );
}

function SlackPrAttachment() {
  const { t } = useTranslation();
  return (
    <div className="mt-2 space-y-2.5 border-l-[3px] border-[#2BAC76] pl-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1 rounded-[4px] bg-[#2BAC76]/15 px-2 py-0.5 font-mono text-[11.5px] text-[#4CD99B]">
          <GitPullRequest className="h-3 w-3" aria-hidden="true" />
          {t("hub.demo.filesChanged")}
        </span>
        <span className="inline-flex items-center gap-1 rounded-[4px] border border-[#35373B] bg-[#222529] px-2 py-0.5 font-mono text-[11.5px] text-[#ABABAD]">
          <Check className="h-3 w-3 text-[#2BAC76]" aria-hidden="true" />
          {t("hub.demo.testsPassed")}
        </span>
      </div>
      <div>
        <span className="inline-flex items-center gap-1.5 rounded-[4px] bg-[#007A5A] px-3 py-1.5 text-xs font-medium text-white">
          <PaseoMark className="h-3.5 w-3.5 text-white" />
          {t("hub.demo.openInPaseo")}
        </span>
      </div>
    </div>
  );
}

function SlackMessage({
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
    <div className="flex items-start gap-2.5 sm:gap-3">
      <SlackAvatar bot={bot} />
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[14px] font-bold text-[#F8F8F8]">{author}</span>
          {bot ? (
            <span className="rounded-[3px] bg-[#2C2D30] px-1.5 py-[1px] text-[10px] font-semibold uppercase tracking-wide text-[#ABABAD]">
              {t("hub.demo.bot")}
            </span>
          ) : null}
          <span className="text-[11px] text-[#ABABAD]">{time}</span>
        </div>
        <div className="text-[13.5px] leading-[1.48] text-[#D1D2D3]">{children}</div>
      </div>
    </div>
  );
}

function SlackAvatar({ bot }: { bot?: boolean }) {
  if (bot) {
    return (
      <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[6px] border border-white/12 bg-[#101615] sm:h-9 sm:w-9">
        <PaseoHubMark className="h-5 w-5 text-white" />
      </div>
    );
  }
  return (
    <img
      src="/9viSwGkz_400x400.jpg"
      alt=""
      width={36}
      height={36}
      loading="lazy"
      decoding="async"
      className="mt-0.5 h-8 w-8 shrink-0 rounded-[6px] object-cover sm:h-9 sm:w-9"
    />
  );
}

function SlackMention() {
  return (
    <span className="rounded-[3px] bg-[#1D9BD1]/20 px-1 py-[1px] font-medium text-[#1D9BD1]">
      @paseo-bot
    </span>
  );
}

function SlackComposer() {
  const { t } = useTranslation();
  return (
    <div
      aria-hidden="true"
      className="mx-4 mt-1 rounded-[8px] border border-[#35373B] bg-[#222529] md:mx-5"
    >
      <div className="px-3 py-2 text-[13px] text-[#ABABAD]/70">
        {t("hub.demo.composerPlaceholder")}
      </div>
      <div className="flex items-center justify-between border-t border-white/[0.06] px-2.5 py-1.5">
        <div className="flex items-center gap-2.5 text-[#ABABAD]/60">
          <Plus className="h-3.5 w-3.5" />
          <AtSign className="h-3.5 w-3.5" />
          <Code className="h-3.5 w-3.5" />
        </div>
        <span className="inline-flex h-6 w-7 items-center justify-center rounded-[4px] bg-[#007A5A]/80 text-white">
          <SendHorizontal className="h-3.5 w-3.5" />
        </span>
      </div>
    </div>
  );
}

function SlackTypingStatus({ reduced }: { reduced: boolean }) {
  const { t } = useTranslation();
  return (
    <div aria-hidden="true" className="flex h-6 items-center px-4 pb-1 md:px-5">
      {reduced ? null : (
        <motion.span
          variants={TYPING_VARIANTS}
          className="inline-flex items-center gap-1.5 text-[11px] text-[#ABABAD]"
        >
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#2BAC76]" />
          {t("hub.demo.typing")}
        </motion.span>
      )}
    </div>
  );
}

function SlackColorMark(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path
        fill="#E01E5A"
        d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313z"
      />
      <path
        fill="#36C5F0"
        d="M8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312z"
      />
      <path
        fill="#2EB67D"
        d="M18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312z"
      />
      <path
        fill="#ECB22E"
        d="M15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z"
      />
    </svg>
  );
}
