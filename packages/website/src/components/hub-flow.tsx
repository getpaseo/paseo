import { ArrowDown, ArrowRight, Clock, Webhook } from "lucide-react";
import type * as React from "react";
import { useTranslation } from "react-i18next";
import { ClaudeCodeIcon, CodexIcon, OpenCodeIcon } from "~/components/agent-icons";
import { DiscordIcon, GitHubIcon, LinearIcon, SlackIcon } from "~/components/brand-icons";
import { HubLockup, PaseoMark } from "~/components/paseo-brand";

export type HubTriggerSourceId =
  | "github"
  | "linear"
  | "slack"
  | "discord"
  | "schedules"
  | "webhooks";

export interface HubTriggerSource {
  id: HubTriggerSourceId;
  Icon: React.ComponentType<{ className?: string }>;
}

/** The six automation sources Hub accepts, shared by the homepage and /hub. */
export const HUB_TRIGGER_SOURCES: readonly HubTriggerSource[] = [
  { id: "github", Icon: GitHubIcon },
  { id: "linear", Icon: LinearIcon },
  { id: "slack", Icon: SlackIcon },
  { id: "discord", Icon: DiscordIcon },
  { id: "schedules", Icon: Clock },
  { id: "webhooks", Icon: Webhook },
] as const;

/** Examples of agent harnesses on connected daemons. */
export const HUB_AGENT_HARNESSES = [
  { name: "Claude Code", Icon: ClaudeCodeIcon },
  { name: "Codex", Icon: CodexIcon },
  { name: "OpenCode", Icon: OpenCodeIcon },
] as const;

const DIAGRAM_DAEMONS = [
  { name: "MacBook Pro", agents: HUB_AGENT_HARNESSES },
  { name: "Hetzner VM", agents: HUB_AGENT_HARNESSES },
] as const;

const DIAGRAM_CLIENTS = ["desktop", "web", "mobile", "cli"] as const;

/** Compact flow diagram for the homepage Paseo Hub section, sitting directly on the page background. */
export function HubLandingFlow() {
  const { t } = useTranslation();
  return (
    <div className="grid items-center gap-5 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,12rem)_auto_minmax(0,1fr)]">
      <div className="space-y-2.5">
        <p className="text-[11px] uppercase tracking-wide text-white/35">
          {t("landing.hubSection.flowTriggers")}
        </p>
        <div className="grid grid-cols-2 gap-2">
          {HUB_TRIGGER_SOURCES.map(({ id, Icon }) => (
            <div
              key={id}
              className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2"
            >
              <Icon className="h-3.5 w-3.5 shrink-0 text-white/70" />
              <span className="truncate text-xs font-medium text-white/85">
                {t(`hub.sources.${id}.name`)}
              </span>
            </div>
          ))}
        </div>
      </div>

      <FlowArrow />

      <div className="rounded-xl border border-brand-green/50 bg-brand-green/[0.12] px-5 py-5 text-center">
        <p className="flex justify-center">
          <HubLockup className="h-5 w-auto text-foreground" />
          <span className="sr-only">{t("hub.shape.hub")}</span>
        </p>
        <p className="mt-2 text-xs text-white/70">{t("hub.shape.hubHosting")}</p>
      </div>

      <FlowArrow />

      <div className="space-y-2.5">
        <p className="text-[11px] uppercase tracking-wide text-white/35">
          {t("landing.hubSection.flowDaemons")}
        </p>
        <div className="space-y-2">
          {DIAGRAM_DAEMONS.map((daemon) => (
            <CompactDaemonRow key={daemon.name} name={daemon.name} agents={daemon.agents} />
          ))}
          <div className="flex items-center gap-2 rounded-lg border border-dashed border-white/10 bg-white/[0.015] px-3 py-2 text-xs text-white/60">
            <PaseoMark className="h-3.5 w-3.5 shrink-0 text-white/75" />
            <span className="truncate">{t("landing.hubSection.flowOpenSession")}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function CompactDaemonRow({
  name,
  agents,
}: {
  name: string;
  agents: readonly { name: string; Icon: React.ComponentType<{ className?: string }> }[];
}) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2">
      <span className="flex min-w-0 items-center gap-2">
        <MachineIcon className="h-4 w-4 shrink-0 text-white/60" />
        <span className="truncate text-xs font-medium text-white/85">{name}</span>
      </span>
      <span className="flex shrink-0 items-center gap-1.5 text-white/45">
        {agents.map(({ name: agentName, Icon }) => (
          <span key={agentName} title={agentName}>
            <Icon className="h-3.5 w-3.5" />
          </span>
        ))}
      </span>
    </div>
  );
}

/** Full vertical infrastructure diagram for the /hub page. */
export function HubArchitectureDiagram() {
  const { t } = useTranslation();
  return (
    <div className="rounded-xl border border-white/[0.08] bg-white/[0.015] p-6 md:p-8">
      <div className="flex flex-col items-center">
        <DiagramRow label={t("hub.shape.triggersRow")}>
          {HUB_TRIGGER_SOURCES.map(({ id, Icon }) => (
            <DiagramCard key={id} Icon={Icon} name={t(`hub.sources.${id}.name`)} />
          ))}
        </DiagramRow>

        <Connector label={t("hub.shape.webhooks")} />

        <div className="w-full max-w-xs rounded-xl border border-brand-green/50 bg-brand-green/[0.12] px-6 py-5 text-center">
          <p className="flex justify-center">
            <HubLockup className="h-[22px] w-auto text-foreground" />
            <span className="sr-only">{t("hub.shape.hub")}</span>
          </p>
          <p className="mt-1.5 text-xs text-white/70">{t("hub.shape.hubHosting")}</p>
        </div>

        <Connector label={t("hub.shape.sameRpcs")} />

        <DiagramRow label={t("hub.shape.daemonsRow")}>
          {DIAGRAM_DAEMONS.map((daemon) => (
            <div
              key={daemon.name}
              className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3"
            >
              <span className="text-white/70">
                <MachineIcon className="h-5 w-5" />
              </span>
              <span className="text-sm font-medium">{daemon.name}</span>
              <span className="flex items-center gap-2 border-l border-white/10 pl-3 text-white/45">
                {daemon.agents.map(({ name, Icon }) => (
                  <span key={name} title={name}>
                    <Icon className="h-4 w-4" />
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
  );
}

function FlowArrow() {
  return (
    <div className="flex items-center justify-center text-white/30" aria-hidden="true">
      <ArrowRight className="hidden h-4 w-4 lg:block" />
      <ArrowDown className="h-4 w-4 lg:hidden" />
    </div>
  );
}

function DiagramRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="w-full space-y-2.5">
      <p className="text-center text-xs uppercase tracking-wide text-white/30">{label}</p>
      <div className="flex flex-wrap justify-center gap-2.5">{children}</div>
    </div>
  );
}

function DiagramCard({
  name,
  Icon,
}: {
  name: string;
  Icon?: React.ComponentType<{ className?: string }>;
}) {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-2.5">
      {Icon ? (
        <span className="text-white/70">
          <Icon className="h-4 w-4" />
        </span>
      ) : null}
      <span className="text-sm font-medium">{name}</span>
    </div>
  );
}

function Connector({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center gap-2 py-4">
      <div className="h-5 w-px border-l border-dashed border-white/25" />
      <p className="text-center text-[11px] text-white/35">{label}</p>
      <div className="h-5 w-px border-l border-dashed border-white/25" />
    </div>
  );
}

function MachineIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <rect x="2" y="2" width="20" height="8" rx="2" />
      <rect x="2" y="14" width="20" height="8" rx="2" />
      <circle cx="6" cy="6" r="1" />
      <circle cx="6" cy="18" r="1" />
    </svg>
  );
}
