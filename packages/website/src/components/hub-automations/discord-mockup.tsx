import { Check, CornerDownRight, GitPullRequest, Hash, PlusCircle } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
import { DiscordIcon } from "~/components/brand-icons";
import {
  MoAvatar,
  MockupStageWindow,
  MockupStep,
  OpenInPaseoChip,
  PaseoBotAvatar,
  type SourceMockupProps,
  WindowTrafficLights,
} from "./shared";

const DISCORD_CHANNELS = ["general", "engineering", "bugs", "releases"] as const;

const STEP_DELAYS = {
  userMention: 0.06,
  threadStart: 0.55,
  botWorking: 1.05,
  botDone: 1.7,
} as const;

const DISCORD_COMPONENTS = {
  mention: (
    <span className="rounded-[3px] bg-[#5865F2]/30 px-1 py-[0.5px] font-medium text-[#C9CDFB]">
      @paseo-bot
    </span>
  ),
  host: (
    <span className="rounded-[3px] bg-[#1E1F22] px-1.5 py-[1px] font-mono text-[11px] text-[#DBDEE1]" />
  ),
  issue: <span className="font-mono text-[12px] text-[#00A8FC]">#2799</span>,
};

export function DiscordSourceMockup({ active, reduceMotion }: SourceMockupProps) {
  const { t } = useTranslation();

  return (
    <MockupStageWindow
      ariaLabel={t("hub.demo.discord.alt")}
      active={active}
      reduceMotion={reduceMotion}
      className="border-[#3F4147] bg-[#313338]"
    >
      <DiscordChrome />

      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[164px_minmax(0,1fr)]">
        <DiscordSidebar />
        <div className="flex min-h-0 min-w-0 flex-col bg-[#313338]">
          <DiscordChannelHeader />
          <DiscordMessageFeed />
          <DiscordComposer />
        </div>
      </div>
    </MockupStageWindow>
  );
}

function DiscordMessageFeed() {
  const { t } = useTranslation();
  return (
    <div className="flex-1 space-y-3 px-4 py-3">
      <MockupStep delay={STEP_DELAYS.userMention}>
        <DiscordMessage author="mo" time={t("hub.demo.discord.time1")}>
          <p>
            <Trans i18nKey="hub.demo.discord.userPrompt" components={DISCORD_COMPONENTS} />
          </p>
        </DiscordMessage>
      </MockupStep>

      <MockupStep
        delay={STEP_DELAYS.threadStart}
        className="flex items-start gap-2 pl-2 text-[11.5px] text-[#949BA4]"
      >
        <CornerDownRight className="h-3.5 w-3.5 shrink-0 text-[#949BA4]" aria-hidden="true" />
        <p>
          <span className="font-medium text-[#F2F3F5]">paseo-bot</span>{" "}
          {t("hub.demo.discord.startedThread")}{" "}
          <span className="font-semibold text-[#F2F3F5]">{t("hub.demo.discord.threadTitle")}</span>
        </p>
      </MockupStep>

      <div className="ml-3 space-y-3 border-l-2 border-[#4E5058] pl-3.5">
        <MockupStep delay={STEP_DELAYS.botWorking}>
          <DiscordMessage author="paseo-bot" time={t("hub.demo.discord.time1")} bot>
            <p className="text-[#DBDEE1]">
              <Trans i18nKey="hub.demo.discord.botStarted" components={DISCORD_COMPONENTS} />
            </p>
          </DiscordMessage>
        </MockupStep>

        <MockupStep delay={STEP_DELAYS.botDone}>
          <DiscordMessage author="paseo-bot" time={t("hub.demo.discord.time2")} bot>
            <p className="text-[#DBDEE1]">{t("hub.demo.discord.botFinished")}</p>
            <DiscordPrEmbed />
          </DiscordMessage>
        </MockupStep>
      </div>
    </div>
  );
}

function DiscordPrEmbed() {
  const { t } = useTranslation();
  return (
    <div className="mt-2 space-y-2">
      <div className="rounded-[4px] border-l-[4px] border-[#2BAC76] bg-[#2B2D31] px-3 py-2.5">
        <div className="flex items-center gap-1.5 text-[12px] font-semibold text-[#00A8FC]">
          <GitPullRequest className="h-3.5 w-3.5 shrink-0 text-[#2BAC76]" aria-hidden="true" />
          <span>getpaseo/paseo#2825</span>
        </div>
        <p className="mt-0.5 text-[12px] text-[#DBDEE1]">
          fix(worktree): prune orphaned branches on close
        </p>
        <div className="mt-2 grid grid-cols-3 gap-2 text-[11px] @max-[14rem]:grid-cols-1">
          <div>
            <p className="font-semibold text-[#B5BAC1]">{t("hub.demo.discord.fieldHost")}</p>
            <p className="font-mono text-[#DBDEE1]">devbox</p>
          </div>
          <div>
            <p className="font-semibold text-[#B5BAC1]">{t("hub.demo.discord.fieldDiff")}</p>
            <p className="font-mono text-[#DBDEE1]">+46 -12</p>
          </div>
          <div>
            <p className="font-semibold text-[#B5BAC1]">{t("hub.demo.discord.fieldChecks")}</p>
            <p className="inline-flex items-center gap-1 text-[#57F287]">
              <Check className="h-3 w-3" aria-hidden="true" />
              {t("hub.demo.shared.testsPassed")}
            </p>
          </div>
        </div>
      </div>

      <div>
        <OpenInPaseoChip variant="discord" />
      </div>
    </div>
  );
}

function DiscordComposer() {
  const { t } = useTranslation();
  return (
    <div
      aria-hidden="true"
      className="mx-4 mt-auto mb-3 flex items-center gap-2.5 rounded-[8px] bg-[#383A40] px-3 py-2 text-[12.5px] text-[#80848E] @max-[14rem]:mx-2 @max-[14rem]:px-2"
    >
      <PlusCircle className="h-4 w-4 shrink-0 text-[#B5BAC1]" />
      <span className="truncate">{t("hub.demo.discord.composerPlaceholder")}</span>
    </div>
  );
}

function DiscordChrome() {
  return (
    <div className="flex h-9 shrink-0 items-center justify-between border-b border-[#1E1F22] bg-[#1E1F22] px-3.5">
      <div className="flex items-center gap-3">
        <WindowTrafficLights />
        <span className="text-[12px] font-semibold text-[#B5BAC1]">Discord</span>
      </div>
      <DiscordIcon className="h-3.5 w-3.5 text-[#5865F2]" />
    </div>
  );
}

function DiscordSidebar() {
  const { t } = useTranslation();
  return (
    <aside
      aria-hidden="true"
      className="hidden flex-col border-r border-[#1F2023] bg-[#2B2D31] md:flex"
    >
      <div className="border-b border-[#1F2023] px-3.5 py-2.5 text-[13.5px] font-bold text-[#F2F3F5]">
        Paseo
      </div>
      <div className="space-y-0.5 px-2 py-3 text-[12.5px]">
        <p className="px-2 pb-1 text-[10.5px] font-semibold uppercase tracking-wide text-[#949BA4]">
          {t("hub.demo.discord.textChannels")}
        </p>
        {DISCORD_CHANNELS.map((channel) => (
          <div key={channel}>
            <div
              className={`flex items-center gap-1.5 rounded-[5px] px-2 py-1 ${
                channel === "engineering"
                  ? "bg-[#404249] font-medium text-[#F2F3F5]"
                  : "text-[#949BA4]"
              }`}
            >
              <Hash className="h-3.5 w-3.5 shrink-0 opacity-75" />
              <span className="truncate">{channel}</span>
            </div>
            {channel === "engineering" ? (
              <div className="mt-0.5 ml-3 flex items-center gap-1.5 border-l border-[#4E5058] py-1 pl-2 text-[11.5px] text-[#DBDEE1]">
                <span className="truncate">{t("hub.demo.discord.threadTitle")}</span>
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </aside>
  );
}

function DiscordChannelHeader() {
  const { t } = useTranslation();
  return (
    <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[#26282C] px-4 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <Hash className="h-4 w-4 shrink-0 text-[#80848E]" aria-hidden="true" />
        <span className="text-[14px] font-semibold text-[#F2F3F5]">engineering</span>
        <span className="hidden h-3.5 w-px bg-[#3F4147] sm:inline-block" aria-hidden="true" />
        <span className="hidden truncate text-[11.5px] text-[#949BA4] sm:inline">
          {t("hub.demo.discord.channelTopic")}
        </span>
      </div>
    </div>
  );
}

function DiscordMessage({
  author,
  time,
  bot,
  children,
}: {
  author: string;
  time: string;
  bot?: boolean;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-start gap-2.5 @max-[14rem]:flex-col @max-[14rem]:gap-1">
      {bot ? (
        <PaseoBotAvatar size="md" rounded="rounded-full" className="mt-0.5" />
      ) : (
        <MoAvatar size="md" rounded="rounded-full" className="mt-0.5" />
      )}
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[13.5px] font-semibold text-[#F2F3F5]">{author}</span>
          {bot ? (
            <span className="inline-flex items-center gap-0.5 rounded-[3px] bg-[#5865F2] px-1.5 py-[1px] text-[9.5px] font-semibold uppercase tracking-wide text-white">
              <Check className="h-2.5 w-2.5" aria-hidden="true" />
              {t("hub.demo.shared.appBadge")}
            </span>
          ) : null}
          <span className="text-[11px] text-[#949BA4]">{time}</span>
        </div>
        <div className="text-[13px] leading-[1.45] text-[#DBDEE1]">{children}</div>
      </div>
    </div>
  );
}
