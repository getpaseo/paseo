import * as LucideIcons from "lucide-react-native";
import { Bot, PackagePlus, type LucideIcon } from "lucide-react-native";
import { createElement, type ComponentType } from "react";
import type { AgentProviderIcon } from "@getpaseo/protocol/agent-types";
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
const providerIconComponents = new Map<string, ProviderIconComponent>();
const MAX_PROVIDER_ICON_LENGTH = 13 * 1024;

function isRenderableProviderSvg(value: string): boolean {
  const svg = value.trim();
  return (
    svg.length <= MAX_PROVIDER_ICON_LENGTH &&
    /^(?:<\?xml[^>]*>\s*)?<svg(?:\s[^>]*)?>[\s\S]*<\/svg>$/iu.test(svg) &&
    !/<\s*(?:script|foreignObject|iframe|object|embed)\b/iu.test(svg) &&
    !/(?:on[a-z]+|(?:xlink:)?href)\s*=/iu.test(svg)
  );
}

function findLucideIcon(name: string): LucideIcon | null {
  const candidate = Reflect.get(LucideIcons, name);
  if (candidate === LucideIcons.Icon || candidate === LucideIcons.createLucideIcon) {
    return null;
  }
  const isComponent =
    typeof candidate === "function" ||
    (typeof candidate === "object" && candidate !== null && "$$typeof" in candidate);
  return isComponent ? (candidate as LucideIcon) : null;
}

function getDeclaredProviderIcon(
  provider: string,
  icon: AgentProviderIcon,
): ProviderIconComponent | null {
  const kind = "svg" in icon ? "svg" : "lucide";
  const value = "svg" in icon ? icon.svg : icon.lucide;
  const cacheKey = `${provider}:${kind}:${value}`;
  const cached = providerIconComponents.get(cacheKey);
  if (cached) return cached;

  if (kind === "svg") {
    if (!isRenderableProviderSvg(value)) return null;
    const DeclaredProviderIcon: ProviderIconComponent = ({ size, color }) =>
      createElement(SvgXml, { xml: value, width: size, height: size, color });
    DeclaredProviderIcon.displayName = `DeclaredProviderIcon(${provider})`;
    providerIconComponents.set(cacheKey, DeclaredProviderIcon);
    return DeclaredProviderIcon;
  }

  const LucideIcon = findLucideIcon(value);
  if (!LucideIcon) return null;
  const DeclaredProviderIcon: ProviderIconComponent = ({ size, color }) =>
    createElement(LucideIcon, { size, color });
  DeclaredProviderIcon.displayName = `DeclaredProviderIcon(${provider})`;
  providerIconComponents.set(cacheKey, DeclaredProviderIcon);
  return DeclaredProviderIcon;
}

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

export function getProviderIcon(
  provider: string,
  declaredIcon?: AgentProviderIcon,
): ProviderIconComponent {
  if (declaredIcon) {
    const icon = getDeclaredProviderIcon(provider, declaredIcon);
    if (icon) return icon;
  }

  const name = resolveProviderIconName(provider);
  if (name.kind === "builtin") {
    return BUILTIN_PROVIDER_ICONS[name.id];
  }
  if (name.kind === "catalog") {
    return getCatalogProviderIcon(name.id);
  }
  return Bot;
}
