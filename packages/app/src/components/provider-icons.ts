import { useStore } from "zustand";
import { providerSnapshotIcons } from "@/data/provider-icons";
import { Bot } from "lucide-react-native";
import { createElement, useCallback, type ComponentType } from "react";
import { SvgXml } from "react-native-svg";
import { AntigravityIcon } from "@/components/icons/antigravity-icon";
import { ClaudeIcon } from "@/components/icons/claude-icon";
import { CodexIcon } from "@/components/icons/codex-icon";
import { CopilotIcon } from "@/components/icons/copilot-icon";
import { KiroIcon } from "@/components/icons/kiro-icon";
import { MiniMaxIcon } from "@/components/icons/minimax-icon";
import { OpenCodeIcon } from "@/components/icons/opencode-icon";
import { OmpIcon } from "@/components/icons/omp-icon";
import { PiIcon } from "@/components/icons/pi-icon";
import { ACP_PROVIDER_CATALOG } from "@/data/acp-provider-catalog";
import { resolveProviderIconName } from "@/components/provider-icon-name";

export interface ProviderIconProps {
  size: number;
  color: string;
}

export type ProviderIconComponent = ComponentType<ProviderIconProps>;

const BUILTIN_PROVIDER_ICONS: Record<string, ProviderIconComponent> = {
  antigravity: AntigravityIcon as unknown as ProviderIconComponent,
  claude: ClaudeIcon as unknown as ProviderIconComponent,
  codex: CodexIcon as unknown as ProviderIconComponent,
  copilot: CopilotIcon as unknown as ProviderIconComponent,
  kiro: KiroIcon as unknown as ProviderIconComponent,
  minimax: MiniMaxIcon as unknown as ProviderIconComponent,
  omp: OmpIcon as unknown as ProviderIconComponent,
  opencode: OpenCodeIcon as unknown as ProviderIconComponent,
  pi: PiIcon as unknown as ProviderIconComponent,
};

const CATALOG_ICON_SVGS = new Map(
  ACP_PROVIDER_CATALOG.flatMap((entry) => (entry.iconSvg ? [[entry.id, entry.iconSvg]] : [])),
);

const catalogIconComponents = new Map<string, ProviderIconComponent>();
const snapshotIconComponents = new Map<string, ProviderIconComponent>();

/** Renders a sanitized SVG string from a host catalog, tinted through `currentColor`. */
export function SvgIcon({ svg, size, color }: ProviderIconProps & { svg: string }) {
  return createElement(SvgXml, { xml: svg, width: size, height: size, color });
}

function createSvgIcon(provider: string, iconSvg: string): ProviderIconComponent {
  const SvgProviderIcon: ProviderIconComponent = ({ size, color }) =>
    SvgIcon({ svg: iconSvg, size, color });
  SvgProviderIcon.displayName = `SvgProviderIcon(${provider})`;
  return SvgProviderIcon;
}

function getCatalogProviderIcon(provider: string): ProviderIconComponent {
  const cached = catalogIconComponents.get(provider);
  if (cached) {
    return cached;
  }
  const iconSvg = CATALOG_ICON_SVGS.get(provider);
  if (!iconSvg) {
    return Bot;
  }
  const icon = createSvgIcon(provider, iconSvg);
  catalogIconComponents.set(provider, icon);
  return icon;
}

function getSnapshotProviderIcon(provider: string, svg: string): ProviderIconComponent {
  const cached = snapshotIconComponents.get(svg);
  if (cached) return cached;
  const component = createSvgIcon(provider, svg);
  snapshotIconComponents.set(svg, component);
  return component;
}

function resolveProviderIcon(provider: string, svg?: string): ProviderIconComponent {
  const name = resolveProviderIconName(provider, svg);
  if (name.kind === "builtin") {
    return BUILTIN_PROVIDER_ICONS[name.id];
  }
  if (name.kind === "catalog") {
    return getCatalogProviderIcon(name.id);
  }
  if (name.kind === "svg") {
    return getSnapshotProviderIcon(provider, name.svg);
  }
  return Bot;
}

export function useProviderIcon(provider: string, serverId?: string | null): ProviderIconComponent {
  const svg = useStore(providerSnapshotIcons, (state) =>
    serverId ? state.get(serverId)?.get(provider) : undefined,
  );
  return resolveProviderIcon(provider, svg);
}

/** Subscribe once for consumers that render a collection of providers. */
export function useProviderIcons(serverId?: string | null) {
  const icons = useStore(providerSnapshotIcons, (state) =>
    serverId ? state.get(serverId) : undefined,
  );
  return useCallback(
    (provider: string) => resolveProviderIcon(provider, icons?.get(provider)),
    [icons],
  );
}
