import { Computer, Globe, Laptop, Monitor, PcCase, Plus, Server, Terminal } from "lucide-react";
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
}

const CONNECTED_HOSTS: ConnectedHost[] = [
  {
    name: "MacBook Pro",
    device: Laptop,
    tone: "text-mock-fg-muted",
    link: "local",
    latency: "1ms",
  },
  {
    name: "devbox",
    device: Server,
    tone: HOST_TONE.devbox,
    link: "relay",
    endpoint: "relay.paseo.sh",
    latency: "38ms",
  },
  {
    name: "mac-mini",
    device: Computer,
    tone: HOST_TONE["mac-mini"],
    link: "tailscale",
    endpoint: "mac-mini:6767",
    latency: "12ms",
  },
  {
    name: "workstation",
    device: PcCase,
    tone: "text-mock-host-orange",
    link: "ssh",
    endpoint: "mo@workstation",
    latency: "24ms",
  },
];

function HostRow({ host, highlighted }: { host: ConnectedHost; highlighted?: boolean }) {
  const { t } = useTranslation();
  const Device = host.device;
  const LinkIcon = LINK_ICON[host.link];
  return (
    <div
      className={`mx-[4px] flex items-start gap-[8px] rounded-[6px] px-[8px] py-[8px] ${highlighted ? "bg-mock-surface2" : ""}`}
    >
      <span className="flex h-[18px] w-[16px] shrink-0 items-center justify-center">
        <span className="size-[8px] rounded-full bg-mock-dot-success" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-[6px]">
          <span className={`shrink-0 ${host.tone}`}>
            <Device size={14} />
          </span>
          <span className="min-w-0 flex-1 truncate text-[13.5px] leading-[18px] text-mock-fg">
            {host.name}
          </span>
        </span>
        <span className="mt-[2px] flex items-center gap-[6px] text-[12px] leading-[16px] text-mock-fg-muted">
          <span className="flex w-[14px] shrink-0 items-center justify-center">
            <LinkIcon size={11} className="shrink-0 opacity-70" />
          </span>
          <span className="shrink-0">{t(`landing.mockup.app.hostLinks.${host.link}`)}</span>
          {host.endpoint ? (
            <span className="min-w-0 truncate opacity-70">{host.endpoint}</span>
          ) : null}
        </span>
      </span>
      <span className="flex h-[18px] shrink-0 items-center text-right text-[12px] leading-[16px] text-mock-fg-muted tabular-nums">
        {host.latency}
      </span>
    </div>
  );
}

/**
 * Every machine this window is connected to: what kind of machine it is, how the app reaches it,
 * and its round trip time.
 */
export function HostsModal() {
  const { t } = useTranslation();
  return (
    <div className="w-[348px] overflow-hidden rounded-[10px] border border-mock-border-accent bg-mock-surface1 py-[4px] shadow-[0_24px_64px_rgba(0,0,0,0.55)]">
      <div className="px-[12px] pt-[4px] pb-[2px] text-[11.5px] font-medium text-mock-fg-muted">
        {t("landing.mockup.app.hosts")}
      </div>
      {CONNECTED_HOSTS.map((host, index) => (
        <HostRow key={host.name} host={host} highlighted={index === 1} />
      ))}
      <div className="my-[4px] border-t border-mock-border" />
      <div className="mx-[4px] flex items-center gap-[8px] rounded-[6px] px-[8px] py-[8px] text-[13px] text-mock-fg">
        {/* The plus sits on the center line of the status dots above it. */}
        <span className="flex size-[16px] shrink-0 items-center justify-center">
          <Plus size={16} className="text-mock-fg-muted" />
        </span>
        {t("landing.mockup.app.addHost")}
      </div>
    </div>
  );
}
