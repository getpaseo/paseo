import { useStore } from "zustand";
import { providerSnapshotIcons } from "@/data/provider-icons";
import { Bot } from "lucide-react-native";
import { createElement, useCallback, type ComponentType } from "react";
import { SvgXml } from "react-native-svg";
import { TERMINAL_PROFILE_ICON_NAMES } from "@getpaseo/protocol/provider-icon-names";
import { AntigravityIcon } from "@/components/icons/antigravity-icon";
import { ClaudeIcon } from "@/components/icons/claude-icon";
import { CodexIcon } from "@/components/icons/codex-icon";
import { CopilotIcon } from "@/components/icons/copilot-icon";
import { KiroIcon } from "@/components/icons/kiro-icon";
import { MiniMaxIcon } from "@/components/icons/minimax-icon";
import { OpenCodeIcon } from "@/components/icons/opencode-icon";
import { OmpIcon } from "@/components/icons/omp-icon";
import { PiIcon } from "@/components/icons/pi-icon";
import { ACP_PROVIDER_ICON_SVGS } from "@/assets/acp-provider-icons";
import { CUSTOM_PROVIDER_ICON_SVGS } from "@/assets/custom-provider-icons";
import { ACP_PROVIDER_CATALOG } from "@/data/acp-provider-catalog";
import { resolveProviderIconName } from "@/components/provider-icon-name";

export interface ProviderIconProps {
  size: number;
  color: string;
  /** Honoured by outline glyphs such as the fallback; brand marks are filled and ignore it. */
  strokeWidth?: number;
}

export type ProviderIconComponent = ComponentType<ProviderIconProps>;

const PROVIDER_BRAND_COLORS: Record<string, string> = {
  agy: "#3186FF",
  antigravity: "#3186FF",
  "claude-acp": "#D97757",
  claude: "#D97757",
  "codex-acp": "#10A37F",
  codex: "#10A37F",
  copilot: "#58A6FF",
  gemini: "#8E75C2",
  "github-copilot-cli": "#58A6FF",
  grok: "#4F46E5",
  kimi: "#7C3AED",
  kiro: "#9046FF",
  minimax: "#E2167E",
  "minimax-code": "#E2167E",
  omp: "#818CF8",
  opencode: "#38BDF8",
  pi: "#818CF8",
  "pi-acp": "#818CF8",
  traecli: "#2563EB",
};

function createBrandedProviderIcon(
  provider: string,
  Icon: ProviderIconComponent,
): ProviderIconComponent {
  const BrandedProviderIcon: ProviderIconComponent = (props) =>
    createElement(Icon, {
      ...props,
      color: PROVIDER_BRAND_COLORS[provider] ?? props.color,
    });
  BrandedProviderIcon.displayName = `BrandedProviderIcon(${provider})`;
  return BrandedProviderIcon;
}

const BUILTIN_PROVIDER_ICONS: Record<string, ProviderIconComponent> = {
  antigravity: createBrandedProviderIcon("antigravity", AntigravityIcon),
  claude: createBrandedProviderIcon("claude", ClaudeIcon),
  codex: createBrandedProviderIcon("codex", CodexIcon),
  copilot: createBrandedProviderIcon("copilot", CopilotIcon),
  kiro: createBrandedProviderIcon("kiro", KiroIcon),
  minimax: createBrandedProviderIcon("minimax", MiniMaxIcon),
  omp: createBrandedProviderIcon("omp", OmpIcon),
  opencode: createBrandedProviderIcon("opencode", OpenCodeIcon),
  pi: createBrandedProviderIcon("pi", PiIcon),
};

const CATALOG_ICON_SVGS = new Map<string, string>(
  ACP_PROVIDER_CATALOG.flatMap((entry) => (entry.iconSvg ? [[entry.id, entry.iconSvg]] : [])),
);

for (const [provider, iconSvg] of Object.entries(CUSTOM_PROVIDER_ICON_SVGS)) {
  CATALOG_ICON_SVGS.set(provider, iconSvg);
}

for (const name of TERMINAL_PROFILE_ICON_NAMES) {
  const iconSvg = (ACP_PROVIDER_ICON_SVGS as Record<string, string | undefined>)[name];
  if (iconSvg) {
    CATALOG_ICON_SVGS.set(name, iconSvg);
  }
}

const catalogIconComponents = new Map<string, ProviderIconComponent>();
const snapshotIconComponents = new Map<string, ProviderIconComponent>();

/** Renders a sanitized SVG string from a host catalog, tinted through `currentColor`. */
export function SvgIcon({ svg, size, color }: ProviderIconProps & { svg: string }) {
  return createElement(SvgXml, { xml: svg, width: size, height: size, color });
}

function createSvgIcon(provider: string, iconSvg: string): ProviderIconComponent {
  const SvgProviderIcon: ProviderIconComponent = ({ size, color }) =>
    SvgIcon({ svg: iconSvg, size, color: PROVIDER_BRAND_COLORS[provider] ?? color });
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
