/**
 * Brand marks are SVG React components, so they cannot travel over the wire as
 * a string. This file derives icon and brand-color lookup tables from
 * CLIENT_FORGE_VIEW_MODULES; a new forge ships an icon component in the client
 * bundle and references it from its view module. Unknown icon kinds fall back to
 * a generic pull-request glyph.
 */
import { withUnistyles } from "react-native-unistyles";
import { GitPullRequest } from "lucide-react-native";
import {
  type ForgeBrandColor,
  type ForgeIconColorMapping,
  type ForgeIconComponent,
} from "@/git/client-forge-module";
import { CLIENT_FORGE_VIEW_MODULES } from "@/git/forges/view";

const FORGE_ICON_BY_KIND = new Map(
  CLIENT_FORGE_VIEW_MODULES.map((module) => [module.id, module.icon]),
);

/**
 * Raw brand icon component for an `iconKind`, for call sites that style with a
 * plain `color` prop. Falls back to a generic pull-request glyph.
 */
export function getForgeIconComponent(iconKind: string): ForgeIconComponent {
  return FORGE_ICON_BY_KIND.get(iconKind) ?? GitPullRequest;
}

const THEMED_ICON_BY_KIND = Object.fromEntries(
  CLIENT_FORGE_VIEW_MODULES.map((module) => [module.id, withUnistyles(module.icon)]),
);
const ThemedGitPullRequest = withUnistyles(GitPullRequest);

/** Theme-driven color mapping, e.g. `(theme) => ({ color: theme.colors.foregroundMuted })`. */
export type { ForgeIconColorMapping };

function brandColorMapping(colors: ForgeBrandColor): ForgeIconColorMapping {
  return (theme) => ({ color: theme.colorScheme === "light" ? colors.light : colors.dark });
}

const BRAND_COLOR_MAPPING_BY_KIND = new Map(
  CLIENT_FORGE_VIEW_MODULES.flatMap((module) =>
    module.brandColor ? [[module.id, brandColorMapping(module.brandColor)] as const] : [],
  ),
);

/**
 * The forge's brand color mapping, or null for forges with no dedicated brand
 * color (github renders in a neutral tone; an unknown forge has none). Call
 * sites pair this with {@link ForgeBrandIcon}: use it to tint the icon, or to
 * decide whether to show a brand badge at all.
 */
export function getForgeBrandColorMapping(iconKind: string): ForgeIconColorMapping | null {
  return BRAND_COLOR_MAPPING_BY_KIND.get(iconKind) ?? null;
}

/**
 * Themed brand icon for an `iconKind`, for call sites that color via a unistyles
 * mapping. Falls back to a generic pull-request glyph for unknown forges.
 */
export function ForgeBrandIcon({
  iconKind,
  size,
  uniProps,
}: {
  iconKind: string;
  size: number;
  uniProps: ForgeIconColorMapping;
}) {
  const ThemedIcon = THEMED_ICON_BY_KIND[iconKind] ?? ThemedGitPullRequest;
  return <ThemedIcon size={size} uniProps={uniProps} />;
}
