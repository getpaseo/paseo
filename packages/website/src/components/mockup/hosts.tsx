import { Computer, Globe, Laptop, Monitor, PcCase, Plus, Server, Terminal, X } from "lucide-react";
import type * as React from "react";
import { useTranslation } from "react-i18next";
import { TailscaleMark } from "./icons";

/**
 * The machines the mockup's workspaces live on. A host's name is the label its owner gave it, and
 * its color is the identity color they picked for its badge. The local machine draws no badge, as
 * a host set to hide its badge does in the app.
 */
export type RemoteHostId = "devbox" | "mac-mini";

/** Badge ink per host, as the app's `HostBadge` paints glyph and label in one identity color. */
const HOST_TONE: Record<RemoteHostId, string> = {
  devbox: "text-mock-host-teal",
  "mac-mini": "text-mock-host-violet",
};

/**
 * The mark that says which machine something runs on: the server glyph and the host's name in its
 * identity color. It inherits its text size, so it sits in a sidebar row, a tool call, or a
 * subagent row alike.
 */
export function HostBadge({ host, glyph = 12 }: { host: RemoteHostId; glyph?: number }) {
  return (
    <span className={`flex shrink-0 items-center gap-[4px] ${HOST_TONE[host]}`}>
      <Server size={glyph} className="shrink-0" />
      {host}
    </span>
  );
}

// --- hosts modal --------------------------------------------------------------

type IconComponent = React.ComponentType<{ size?: number; className?: string }>;

/** How the app reaches a host. Tailscale is a direct TCP connection to a tailnet name. */
type HostLink = "local" | "relay" | "tailscale" | "ssh";

const LINK_ICON: Record<HostLink, IconComponent> = {
  local: Monitor,
  relay: Globe,
  tailscale: TailscaleMark,
  ssh: Terminal,
};

interface ConnectedHost {
  name: string;
  device: IconComponent;
  tone: string;
  link: HostLink;
  /** The address in use. The local daemon has none worth showing. */
  endpoint?: string;
  /** Round trip time, formatted as the app's `formatLatency` prints it. */
  latency: string;
  agents: number;
}

const CONNECTED_HOSTS: ConnectedHost[] = [
  {
    name: "MacBook Pro",
    device: Laptop,
    tone: "text-mock-fg-muted",
    link: "local",
    latency: "1ms",
    agents: 4,
  },
  {
    name: "devbox",
    device: Server,
    tone: HOST_TONE.devbox,
    link: "relay",
    endpoint: "relay.paseo.sh",
    latency: "38ms",
    agents: 6,
  },
  {
    name: "mac-mini",
    device: Computer,
    tone: HOST_TONE["mac-mini"],
    link: "tailscale",
    endpoint: "mac-mini:6767",
    latency: "12ms",
    agents: 3,
  },
  {
    name: "workstation",
    device: PcCase,
    tone: "text-mock-host-orange",
    link: "ssh",
    endpoint: "mo@workstation",
    latency: "24ms",
    agents: 2,
  },
];

function HostRow({ host }: { host: ConnectedHost }) {
  const { t } = useTranslation();
  const Device = host.device;
  const LinkIcon = LINK_ICON[host.link];
  return (
    <div className="flex items-center gap-[13px] border-t border-mock-border px-[18px] py-[13px]">
      <span
        className={`relative flex size-[36px] shrink-0 items-center justify-center rounded-[9px] bg-mock-surface2 ${host.tone}`}
      >
        <Device size={18} />
        <span className="absolute -right-[2px] -bottom-[2px] size-[9px] rounded-full bg-mock-dot-success ring-2 ring-mock-surface1" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] leading-[18px] text-mock-fg">
          {host.name}
        </span>
        <span className="mt-[3px] flex items-center gap-[6px] text-[12px] leading-[16px] text-mock-fg-muted">
          <LinkIcon size={12} className="shrink-0" />
          <span className="text-mock-fg">{t(`landing.mockup.app.hostLinks.${host.link}`)}</span>
          {host.endpoint ? <span className="min-w-0 truncate">{host.endpoint}</span> : null}
        </span>
      </span>
      <span className="shrink-0 text-right">
        <span className="block text-[13px] leading-[18px] text-mock-fg tabular-nums">
          {host.latency}
        </span>
        <span className="mt-[3px] block text-[12px] leading-[16px] text-mock-fg-muted">
          {t("landing.mockup.app.agentCount", { count: host.agents })}
        </span>
      </span>
    </div>
  );
}

/**
 * Every machine this window is connected to: what kind of machine it is, how the app reaches it,
 * the round trip time, and how many agents it runs.
 */
export function HostsModal() {
  const { t } = useTranslation();
  return (
    <div className="w-[468px] overflow-hidden rounded-[14px] border border-mock-border-accent bg-mock-surface1 shadow-[0_24px_64px_rgba(0,0,0,0.55)]">
      <div className="flex h-[46px] items-center justify-between px-[18px]">
        <span className="text-[14px] font-medium text-mock-fg">
          {t("landing.mockup.app.hosts")}
        </span>
        <X size={15} className="text-mock-fg-muted" />
      </div>
      {CONNECTED_HOSTS.map((host) => (
        <HostRow key={host.name} host={host} />
      ))}
      <div className="flex h-[46px] items-center gap-[13px] border-t border-mock-border px-[18px] text-[13px] text-mock-fg">
        {/* The plus sits on the center line of the device tiles above it. */}
        <span className="flex w-[36px] shrink-0 justify-center">
          <Plus size={15} className="text-mock-fg-muted" />
        </span>
        {t("landing.mockup.app.addHost")}
      </div>
    </div>
  );
}
