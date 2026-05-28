import { Bot, PackagePlus } from "lucide-react-native";
import { createElement, type ComponentType } from "react";
import { SvgXml } from "react-native-svg";
import { ClaudeIcon } from "@/components/icons/claude-icon";
import { CodexIcon } from "@/components/icons/codex-icon";
import { CopilotIcon } from "@/components/icons/copilot-icon";
import { OpenCodeIcon } from "@/components/icons/opencode-icon";
import { PiIcon } from "@/components/icons/pi-icon";
import { ACP_PROVIDER_CATALOG } from "@/data/acp-provider-catalog";
import {
  resolveProviderIconName,
  type BuiltinProviderIconName,
} from "@/components/provider-icon-name";

export interface ProviderIconProps {
  size: number;
  color: string;
}

export type ProviderIconComponent = ComponentType<ProviderIconProps>;

const BUILTIN_PROVIDER_ICONS: Record<BuiltinProviderIconName, ProviderIconComponent> = {
  claude: ClaudeIcon as unknown as ProviderIconComponent,
  codex: CodexIcon as unknown as ProviderIconComponent,
  copilot: CopilotIcon as unknown as ProviderIconComponent,
  kiro: PackagePlus,
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
  const iconSvg = CATALOG_ICON_SVGS.get(provider) ?? "";
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
  return Bot;
}
