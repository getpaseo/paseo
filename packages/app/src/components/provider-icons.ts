import { Bot, PackagePlus } from "lucide-react-native";
import { createElement, type ComponentType } from "react";
import { Image } from "react-native";
import { SvgXml } from "react-native-svg";
import { ClaudeIcon } from "@/components/icons/claude-icon";
import { CodexIcon } from "@/components/icons/codex-icon";
import { CopilotIcon } from "@/components/icons/copilot-icon";
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
  claude: ClaudeIcon as unknown as ProviderIconComponent,
  codex: CodexIcon as unknown as ProviderIconComponent,
  copilot: CopilotIcon as unknown as ProviderIconComponent,
  kiro: PackagePlus,
  minimax: MiniMaxIcon as unknown as ProviderIconComponent,
  omp: OmpIcon as unknown as ProviderIconComponent,
  opencode: OpenCodeIcon as unknown as ProviderIconComponent,
  pi: PiIcon as unknown as ProviderIconComponent,
};

const CATALOG_ICON_SVGS = new Map(
  ACP_PROVIDER_CATALOG.flatMap((entry) => (entry.iconSvg ? [[entry.id, entry.iconSvg]] : [])),
);

const catalogIconComponents = new Map<string, ProviderIconComponent>();

function createCatalogIcon(provider: string, iconSvg: string): ProviderIconComponent {
  const CatalogProviderIcon: ProviderIconComponent = ({ size, color }) =>
    createElement(SvgXml, {
      xml: iconSvg,
      width: size,
      height: size,
      color,
    });
  CatalogProviderIcon.displayName = `CatalogProviderIcon(${provider})`;
  return CatalogProviderIcon;
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
  const icon = createCatalogIcon(provider, iconSvg);
  catalogIconComponents.set(provider, icon);
  return icon;
}

export function getProviderIcon(provider: string): ProviderIconComponent {
  const name = resolveProviderIconName(provider);
  if (name.kind === "builtin") {
    return BUILTIN_PROVIDER_ICONS[name.id];
  }
  if (name.kind === "catalog") {
    return getCatalogProviderIcon(name.id);
  }
  const dashboardIconUrl = getDashboardIconUrl(provider);
  if (dashboardIconUrl) {
    return createDashboardIcon(dashboardIconUrl);
  }
  return Bot;
}

// dashboard-icons (Homarr Labs) CDN — https://github.com/homarr-labs/dashboard-icons
// Used as a logo fallback for providers with no bundled SVG. Slugs are the icon's repo
// slug; providers are mapped to the closest matching icon.
const DASHBOARD_ICON_BASE = "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg";
const DASHBOARD_ICON_SLUGS: Record<string, string> = {
  // ACP catalog entries without a local iconSvg get a dashboard-icons fallback.
  gemini: "gemini",
  grok: "xai",
  cursor: "cursor",
  qwen: "qwen",
  ollama: "ollama",
  codex: "codex",
  opencode: "opencode",
  devin: "devin",
  goose: "goose",
  kimi: "kimi",
  deepagents: "deepagents",
};

function getDashboardIconUrl(provider: string): string | null {
  const slug = DASHBOARD_ICON_SLUGS[provider];
  return slug ? `${DASHBOARD_ICON_BASE}/${slug}.svg` : null;
}

function createDashboardIcon(url: string): ProviderIconComponent {
  const DashboardProviderIcon: ProviderIconComponent = ({ size }) =>
    createElement(Image, {
      source: { uri: url },
      style: { width: size, height: size, resizeMode: "contain" },
    });
  DashboardProviderIcon.displayName = `DashboardProviderIcon(${url})`;
  return DashboardProviderIcon;
}
